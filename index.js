var redis = require('redis');
var bro = require('brototype');
var _ = require('lodash');

function Fantastico (config) {
    var self = this;
    var typeOffsets = {};

    self.connections = [];

    /**
     * Adds the given config master to start building the Redis "tree".
     */
    self.initialize = function () {
        self.addConnection(config.port, config.host);
    };

    /**
     * Gets a redis master.
     *
     * @return {Redis.Client|undefined}
     */
    self.getMaster = function (id) {
        return self.findNext('master', id);
    };

    /**
     * Gets a redis slave. If there are no slaves (single-cluster system, for
     * example) it'll get a master.
     *
     * @return {Redis.Client|undefined}
     */
    self.getSlave = function (id) {
        return self.findNext('slave', id) || self.getMaster();
    };

    /**
     * Finds an instance of a connection with the given role, or attempts
     * to get the ID if possible. Round-robin selection.
     *
     * @param  {string} role
     * @param  {string} id
     * @return {Redis.Client}
     */
    self.findNext = function (role, id) {
        if (typeof id !== 'undefined') {
            var c = _.find(self.connections, {
                role: role,
                id: id,
                ready: true
            });

            if (c) {
                return c;
            }
        }

        // Pick out all ready connections in the role we're looking for.
        var connections = _.where(self.connections, {role: role, ready: true});

        // If we don't have any connections matching the criteria, be undefined
        if (connections.length === 0) {
            return undefined;
        }

        // Get the next connection in the "round robin" selection.
        typeOffsets[role] = typeOffsets[role] || 0;
        if (connections.length <= typeOffsets[role]) {
            typeOffsets[role] = 0;
        }

        var connection = connections[typeOffsets[role]++];

        // Compact the metadata and connection into a single object. Makes
        // consuming the library easier without running the risk of overwriting
        // actual client data in the application.
        return _.extend({}, connection, connection.client);
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
            id: [host, port].join(':'),
            options: config.options || {},
            ready: false,
            client: redis.createClient(port, host, config.options || {})
        };

        // On an error, remove this connection from the array (it's no longer)
        // working, and set a timeout to try to reestablish it.
        connection.client.on('error', function (error) {
            self.connections = _.reject(self.connections, {port: port, host: host});

            setTimeout(function () {
                self.addConnection(port, host);
            }, config.check_interval);
        });

        // When it's connected, poll the connection for informations...
        connection.client.on('connect', function () {
            pollConnection(connection);
        });

        self.connections.push(connection);
    };

    /**
     * Checks the connection. Sends a ROLE command out.
     *
     * @param  {{}} connection
     */
    function pollConnection (connection) {
        connection.client.send_command('ROLE', [], function (err, role) {
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
            _.forEach(role.slaves || [], function (slave) {
                if (typeof _.find(self.connections, {
                    host: slave.host,
                    port: slave.port
                }) === 'undefined') {
                    self.addConnection(slave.port, slave.host);
                }
            });

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
    var output = {
        /**
         * Instantiates, returns, and swaps in a new Fantastico instance.
         *
         * @param {{}} config
         * @return {Fantastico}
         */
        create: function (config) {
            output.instance = new Fantastico(config);
            return output.instance;
        },
        /**
         * Swaps out the singleton instance.
         *
         * @param  {*} i
         * @return {void}
         */
        swap: function (i) {
            output.instance = i;
        },

        class: Fantastico
    };

    return output;
})();

