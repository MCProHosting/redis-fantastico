var redis = require('redis');
var bro = require('brototype');
var _ = require('lodash');

function Fantastico (config) {
    var connections = [];

    /**
     * Adds the given config master to start building the Redis "tree".
     */
    self.initialize = function () {
        self.addConnection(config.port, config.host);
    };

    /**
     * Gets a redis master.
     *
     * @return {Redis.Client}
     */
    self.getMaster = function () {
        return self.findRandom('master', id);
    };

    /**
     * Gets a redis slave.
     *
     * @return {Redis.Client}
     */
    self.getSlave = function (id) {
        return self.findRandom('slave', id);
    };

    /**
     * Finds a random instance of a connection with the given role, or attempts
     * to get the ID if possible.
     *
     * @param  {string} role
     * @param  {string} id
     * @return {Redis.Client}
     */
    self.findRandom = function (role, id) {
        if (typeof id !== 'undefined') {
            var c = _.find(connections, {role: role, id: id});

            if (c) {
                return c;
            }
        }

        return _.sample(_.where(connections, {role: role}), 1).client;
    };

    /**
     * Returns a new instance of the "master" redis client.
     *
     * @return {Redis.Client}
     */
    self.addConnection = function  (port, host) {
        var connection = {
            port: port,
            host: host,
            id: [port, host].join(':'),
            options: options || {},
            ready: false,
            client: redis.createClient(port, host, config.options || {})
        };

        // On an error, remove this connection from the array (it's no longer)
        // working, and set a timeout to try to reestablish it.
        connection.client.on('error', function (error) {
            connections = _.reject(connections, {port: port, host: host});

            setTimeout(function () {
                self.addConnection(port, host);
            }, config.check_interval);
        });

        // When it's connected, poll the connection for informations...
        connection.client.on('connect', function () {
            pollConnection(connection);
        });

        connections.push(addConnection);
    };

    /**
     * Checks the connection. Sends a ROLE command out.
     *
     * @param  {{}} connection
     */
    function pollConnection (connection) {
        connection.send_command('ROLE', [], function (err, role) {
            // First schedule a new check to run. We want to do this before
            // checking for an error, to monitor if the connection comes back
            // into a healthy state.
            setTimeout(function () {
                pollConnection(connection);
            }, config.check_interval);

            // If there's an error, say this connection is no longer ready.
            if (err) {
                connection.ready = false;
                throw err;
            }

            // If we got slaves back, check each of them to see if we already
            // have them in our connections. If not, then add the connection!
            // In this way we kind of build outwards from all masters. If one
            // master is out of date or we add new connections dynamically,
            // we can handle that!
            if (role.slaves) {
                _.forEach(role.slaves, function (slave) {
                    if (!_.find(connections, {
                        host: slave.host,
                        port: slave.port
                    })) {
                        self.addConnection(slave.host, slave.port);
                    }
                });
            }

            // The command was successful, so this connection is ready...
            connection.ready = true;
            // Update the record to the record data.
            _.extend(connection, role);
        });
    }
}

/**
 * Parses the roll response.
 *
 * @param  {{}} response
 * @return {{}}
 */
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
        break;

        case 'slave':
            role.role = 'slave';
            role.master = {host: response[1], port: response[2]};
            role.status = response[3];
            role.offset = response[4];
            role.ready  = (role.status === 'connected');
        break;

        case 'setinel':
            role.role = 'sentinel';
            role.masters = response[1];
        break;
    }

    return role;
}

module.exports = (function () {
    var instance = new Fantastico();

    return {
        /**
         * Returns the instance of Fantasico (singleton pattern).
         *
         * @return {Fantastico}
         */
        instance: function () {
            return instance;
        },
        /**
         * Instantiates and returns a new Fantastico instance.
         *
         * @return {Fantastico}
         */
        create: function () {
            return new Fantastico();
        },
        /**
         * Swaps out the singleton instance.
         *
         * @param  {*} i
         * @return {void}
         */
        swap: function (i) {
            instance = i;
        }
    };
})();

