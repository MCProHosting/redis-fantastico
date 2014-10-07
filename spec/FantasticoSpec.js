var redis = require('redis');
var fantastico = require('../index');

describe("Fantasico container", function () {
    it("functions correctly", function () {
        expect(fantastico.instance).toBe(undefined);
        fantastico.swap(42);
        expect(fantastico.instance).toBe(42);
        fantastico.create({});
        expect(fantastico.instance instanceof fantastico.class).toBe(true);
    });
});

describe("Fantastico selections", function () {
    var f;

    beforeEach(function () {
        f = fantastico.create();
        f.connections = [
            {role: 'master', id: 0, ready: true},
            {role: 'slave', id: 1, ready: true},
            {role: 'master', id: 2, ready: false},
            {role: 'slave', id: 3, ready: true},
            {role: 'master', id: 4, ready: true},
            {role: 'slave', id: 5, ready: false},
            {role: 'master', id: 6, ready: true},
        ];
    });

    it("selects via round robin", function () {
        expect(f.findNext('master').id).toBe(0);
        expect(f.findNext('master').id).toBe(4);

        expect(f.findNext('slave').id).toBe(1);
        expect(f.findNext('slave').id).toBe(3);
        expect(f.findNext('slave').id).toBe(1);

        expect(f.findNext('master').id).toBe(6);
        expect(f.findNext('master').id).toBe(0);
    });

    it("selects by id", function () {
        expect(f.findNext('master', 6).id).toBe(6);
        expect(f.getMaster(6).id).toBe(6);
        expect(f.findNext('slave', 6).id).not.toBe(6);
        expect(f.getSlave(6).id).not.toBe(6);
    });

    it("selects the master correctly", function () {
        expect(f.getMaster().id).toBe(0);
        expect(f.getMaster().id).toBe(4);
        expect(f.getMaster().id).toBe(6);
        expect(f.getMaster().id).toBe(0);
    });

    it("selects the slave correctly", function () {
        expect(f.getSlave().id).toBe(1);
        expect(f.getSlave().id).toBe(3);
        expect(f.getSlave().id).toBe(1);
    });

    it("gets master if no available slaves", function () {
        f.connections = [
            {role: 'master', id: 1, ready: true},
            {role: 'slave', id: 2, ready: false},
            {role: 'slave', id: 3, ready: false}
        ];

        expect(f.getSlave().id).toBe(1);
    });

    it("is undefined if no available anythings", function () {
        f.connections = [];

        expect(f.getSlave()).toBe(undefined);
    });
});

describe("Fantastico redis link", function () {
    var creations, commands, events, f;

    redis.createClient = function () {
        creations.push(arguments);
        return redis;
    };
    redis.on = function (event, handler) {
        events[event] = handler;
    };
    redis.send_command = function () {
        commands.push(arguments);
    };

    beforeEach(function () {
        jasmine.clock().install();
        creations = [];
        commands = [];
        events = {};
        f = fantastico.create({
            port: 'port',
            host: 'host',
            options: {options: true},
            check_interval: 2
        });
        f.initialize();
    });

    afterEach(function() {
        jasmine.clock().uninstall();
    });

    it("should create itself", function () {
        expect(f.connections[0]).toEqual({
            port: 'port',
            host: 'host',
            id: 'host:port',
            options: {options: true},
            ready: false,
            client: redis
        });
    });

    it("should fire connect event", function () {
        expect(commands.length).toBe(0);
        events.connect();
        expect(commands.length).toBe(1);
    });

    it("should fire error event", function () {
        expect(creations.length).toBe(1);
        expect(f.connections.length).toBe(1);
        events.error();
        expect(f.connections.length).toBe(0);
        expect(creations.length).toBe(1);

        jasmine.clock().tick(3);

        expect(f.connections.length).toBe(1);
        expect(creations.length).toBe(2);
    });

    describe("polling", function () {
        var roleFn;
        beforeEach(function () {
            events.connect();
            roleFn = commands[0][2];
        });

        it("should unset ready and throw error on fail", function () {
            f.connections[0].ready = true;
            expect(function() {
                roleFn(new Error('bar'));
            }).toThrowError('bar');
            expect(f.connections[0].ready).toBe(false);
        });

        it("should poll again", function () {
            expect(commands.length).toBe(1);
            roleFn(null, {});

            jasmine.clock().tick(3);

            expect(commands.length).toBe(2);
        });

        it("should set the status to active and extend on success", function () {
            expect(f.connections[0].ready).toBe(false);
            expect(f.connections[0].foo).toBe(undefined);
            roleFn(null, {foo: 'bar'});
            expect(f.connections[0].foo).toBe('bar');
            expect(f.connections[0].ready).toBe(true);
        });

        it("should dispatch slaves correctly", function () {
            expect(f.connections.length).toBe(1);
            roleFn(null, {slaves: [
                {host: 1, port: 2},
                {host: 2, port: 3}
            ]});
            expect(f.connections.length).toBe(3);
            roleFn(null, {slaves: [
                {host: 1, port: 2},
                {host: 4, port: 5}
            ]});
            expect(f.connections.length).toBe(4);

            expect(f.connections[1]).toEqual({
                host: 1,
                port: 2,
                id: "1:2",
                options: {options: true},
                ready: false,
                client: redis
            });
            expect(f.connections[2]).toEqual({
                host: 2,
                port: 3,
                id: "2:3",
                options: {options: true},
                ready: false,
                client: redis
            });
        });
    });
});