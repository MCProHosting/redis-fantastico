var redis = require('redis');
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
     * @param {Number=} id
     * @return {Redis.Client|undefined}
     */
    self.getMaster = function (id) {
        return self.findNext('master', id);
    };

    /**
     * Gets a redis slave. If there are no slaves (single-cluster system, for
     * example) it'll get a master *unless* we requested a specific ID.
     *
     * @param {Number=} id
     * @return {Redis.Client|undefined}
     */
    self.getSlave = function (id) {
        return self.findNext('slave', id) || (typeof id === 'undefined' ? self.getMaster() : undefined);
    };

    /**
     * Checks out a *new* connection from the type (or duplicates an
     * existing connect by ID). This is especially useful for long-lived
     * pubsubs. Note that, at the time of it being returned, the connection
     * will not have been established yet. Note that this will not add the
     * new connection to the global connection pool!
     *
     * @param  {String} type
     * @param  {Number} id
     * @return {Redis.Client}
     */
    self.checkout = function (type, id) {
        var client = self.findNext(type, id);

        return redis.createClient(
            client.connectionOption.port,
            client.connectionOption.host,
            config.options || {}
        );
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
        // If we defined a role/id, add that to the things we want to pick from.
        var picks = { ready: true };
        if (typeof role !== 'undefined') {
            picks.role = role;
        }
        if (typeof id !== 'undefined') {
            picks.id = id;
        }
        // Pick out all ready connections in the role we're looking for.
        var connections = _.where(self.connections, picks);

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
        var connection = getConnectionRecord(port, host);

        // On an or close, remove this connection from the array (it's no longer)
        // working, and set a timeout to try to reestablish it.
        function reconnect () {
            if (connection.killed) {
                return;
            }

            // Make sure the connection is closed...
            try {
                connection.client.end();
            } catch (e) {}

            // Remove this from the available connections.
            self.connections = _.reject(self.connections, {port: port, host: host});
            connection.killed = true;

            // Wait and reconnect.
            setTimeout(function () {
                self.addConnection(port, host);
            }, config.check_interval);
        }

        connection.client.on('error', reconnect);
        connection.client.on('end', reconnect);

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
            if (err && err.message !== "ERR unknown command 'ROLE'") {
                connection.ready = false;
                throw err;
            }

            // If we got slaves back, check each of them to see if we already
            // have them in our connections. If not, then add the connection!
            // In this way we kind of build outwards from all masters. If one
            // master is out of date or we add new connections dynamically,
            // we can handle that!
            role = getRole(role || []);

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

    /**
     * Gets a connection "record" for usage internally.
     * @param  {Number} port
     * @param  {String} host
     * @return {Object}
     */
    function getConnectionRecord (port, host) {
        return {
            port: port,
            host: host,
            id: [host, port].join(':'),
            options: config.options || {},
            ready: false,
            client: redis.createClient(port, host, config.options || {})
        };
    }
}

/**
 * Parses the roll response.
 *
 * @param  {{}} response
 * @return {{}}
 */
function getRole (response) {
    var role = {
        role: 'master'
    };
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

