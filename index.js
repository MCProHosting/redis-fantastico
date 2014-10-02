var redis = require('redis');
var bro = require('brototype');
var _ = require('lodash');

module.exports = (function (config) {
    var master;
    var slaves = {};

    master = new redis.createClient(config.port, config.host, config.options);

    master.ready = false;
    master.on('error', function (e) {
        master.ready = false;
    });

    master.on('connect', function () {
        master.ready = true;
    });

    master.send_command('ROLE', [], function (err, role) {
        if (err || !role) {
            return;
        }
        role = getRole(role);
        master.role = role;

        role.slaves.forEach(setupSlave);
    });

    function getMaster() {
        return master;
    }

    function getSlave(id) {
        if (!id)  {
            var ids = _.keys(slaves);
            id = _.random(0, ids.length - 1);
        }
        return slaves[id] || master;
    }

    function createMasterClient () {
        return redis.createClient(config.port, config.host, config.options);
    }

    function createSlaveClient () {
        var slave;
        if (bro(master).doYouEven(role.slaves)) {
            var i = _.random(0, master.role.slaves - 1);
            slave = master.role.slaves[i];
        } else {
            slave = {host: config.host, port: config.port};
        }

        return redis.createClient(slave.port, slave.host, config.options);
    }

    function setupSlave(slave) {
        var id = slave.host + ':' + slave.port;

        var client = new redis.createClient(slave.port, slave.host, config.options);
        client.id = id;
        client.on('error', function (error) {
            // LOG TO SENTRY
            client.ready = false;

            clearInterval(client.interval);
        });
        client.on('connect', function () {
            updateSlaveStatus(client);

            client.interval = setInterval(updateSlaveStatus, config.check_interval, client);
        });

        slaves[id] = client;
    }

    function updateSlaveStatus(slave) {
        slave.send_command('ROLE', [], function (err, role) {
            if (err || !role) {
                slave.ready = false;
                return;
            }
            role = getRole(role);
            slave.ready = role.ready;
        });
    }

    module.exports = {
        getMaster: getMaster,
        getSlave: getSlave,
        createMasterClient: createMasterClient,
        createClient: createMasterClient,
        createSlaveClient: createSlaveClient
    };
    return module.exports;
});

function getRole (response) {
    var role = {};
    switch (response[0]) {

    case 'master':
        role.role = 'master';
        role.offset = response[1];

        role.slaves = _.map(response[2],
            function (slave) {
                return {
                host: slave[0],
                port: slave[1],
                offset: slave[2]
            };
        });

    return role;

    case 'slave':
        role.role = 'slave';
        role.master = {host: response[1], port: response[2]};
        role.status = response[3];
        role.offset = response[4];
        role.ready  = (role.status === 'connected');
    return role;

    case 'setinel':
        role.role = 'sentinel';
        role.masters = response[1];
    return role;

    default:
    return null;
    }
}
