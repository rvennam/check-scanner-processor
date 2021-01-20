/**
 * Copyright 2015-2018 IBM
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
/**
 * Licensed Materials - Property of IBM
 * © Copyright IBM Corp. 2015-2018
 */
var Kafka = require('node-rdkafka');
require('dotenv').config({path: '../.env'});
var ProducerLoop = require('./producerLoop.js');
var ConsumerLoop = require('./consumerLoop.js');
var fs = require('fs');


var opts = {};
var topicName = 'work-topic';
var runProducer = false;
var runConsumer = true;
var producer, consumer, admin;
var services;

var eventStreamsCredentials;

if (process.env.EVENTSTREAMS_CREDENTIALS) {
    console.log('Found Event Streams credentials in EVENTSTREAMS_CREDENTIALS env var')
    eventStreamsCredentials = JSON.parse(process.env.EVENTSTREAMS_CREDENTIALS);
} else {
    console.log('Missing env var EVENTSTREAMS_CREDENTIALS, trying credentials.json');
    try {
        eventStreamsCredentials = require('./credentials.json').EVENTSTREAMS_CREDENTIALS
    }
    catch (e) {
        console.log('Event Streams credentials not found!')
        return;
    }
}

services = eventStreamsCredentials;
if (services.hasOwnProperty('instance_id')) {
    opts.brokers = services.kafka_brokers_sasl;
    opts.api_key = services.api_key;
} else {
    for (var key in services) {
        if (key.lastIndexOf('messagehub', 0) === 0) {
            eventStreamsService = services[key][0];
            opts.brokers = eventStreamsService.credentials.kafka_brokers_sasl;
            opts.api_key = eventStreamsService.credentials.api_key;
        }
    }
}

opts.calocation = '/etc/ssl/certs';
if (process.platform === "darwin") {
    opts.calocation = '/usr/local/etc/openssl@1.1/cert.pem'
} else if (fs.existsSync("/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem")) {
    opts.calocation = '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem'
}

console.log("Kafka Endpoints: " + opts.brokers);

if (!opts.hasOwnProperty('brokers') || !opts.hasOwnProperty('api_key') || !opts.hasOwnProperty('calocation')) {
    console.error('Error - Failed to retrieve options. Check that app is bound to an Event Streams service or that command line options are correct.');
    process.exit(-1);
}

// Shutdown hook
function shutdown(retcode) {
    if (admin) { // admin.isConnected() not present
        admin.disconnect();
    }

    if (producer && producer.isConnected()) {
        console.log("producer disconnecting")
        producer.disconnect(function (err, data) {
            console.log("producer disconnected")
            if (!consumer) {
                console.log("process exiting");
                process.exit(retcode);
            }
        });
    }

    if (consumer) {
        clearInterval(ConsumerLoop.consumerLoop);
    }

    if (consumer && consumer.isConnected()) {
        console.log("consumer disconnecting")
        consumer.disconnect(function (err, data) {
            console.log("consumer disconnected")
            // heuristic delay to allow for the producer to disconnect
            setTimeout(function () {
                console.log("process exit");
                process.exit(retcode);
            }, 2000);
        });
    }

    // Workaround for the rare case process(exit) may never be called
    // see https://github.com/Blizzard/node-rdkafka/issues/222
    setTimeout(function () {
        console.log("process kill");
        process.kill(process.pid, -9);
    }, 10000);
}

process.on('SIGTERM', function () {
    console.log('Shutdown received.');
    shutdown(0);
});
process.on('SIGINT', function () {
    console.log('Shutdown received.');
    shutdown(0);
});

// Config options common to all clients
var driver_options = {
    //'debug': 'all',
    'metadata.broker.list': opts.brokers,
    'security.protocol': 'sasl_ssl',
    'ssl.ca.location': opts.calocation,
    'sasl.mechanisms': 'PLAIN',
    'sasl.username': 'token',
    'sasl.password': opts.api_key,
    'broker.version.fallback': '0.10.0',  // still needed with librdkafka 0.11.6 to avoid fallback to 0.9.0
    'log.connection.close': false
};

var admin_opts = {
    'client.id': 'kafka-nodejs-console-sample-admin',
};

// Add the common options to client and producer
for (var key in driver_options) {
    admin_opts[key] = driver_options[key];
}

// Use the AdminClient API to create the topic
// with 1 partition and a retention period of 24 hours.
console.log('Creating the topic ' + topicName + ' with AdminClient');
admin = Kafka.AdminClient.create(admin_opts);
admin.connect();
console.log("AdminClient connected");

admin.createTopic({
    topic: topicName,
    num_partitions: 1,
    replication_factor: 3,
    config: { 'retention.ms': (24 * 60 * 60 * 1000).toString() }
},
    function (err) {
        if (err) {
            console.log(err);
        } else {
            console.log('Topic ' + topicName + ' created');
        }

        // carry on if topic created or topic already exists (code 36)
        if (!err || err.code == 36) {
            runLoops();
            console.log("This sample app will run until interrupted.");
            admin.disconnect();
        } else {
            shutdown(-1);
        }
    }
);

// runLoops();

// Build and start the producer/consumer
function runLoops() {
    var consumer_opts = {
        'client.id': 'kafka-nodejs-console-sample-consumer',
        'group.id': 'kafka-nodejs-console-sample-group'
    };

    var producer_opts = {
        'client.id': 'kafka-nodejs-console-sample-producer',
        'dr_msg_cb': true  // Enable delivery reports with message payload
    };

    console.log(consumer_opts);

    // Add the common options to client and producer
    for (var key in driver_options) {
        consumer_opts[key] = driver_options[key];
        producer_opts[key] = driver_options[key];
    }
    console.log(consumer_opts);
    // Start the clients
    if (runConsumer) {
        consumer = ConsumerLoop.buildConsumer(Kafka, consumer_opts, topicName, shutdown);
        consumer.connect();
    }

    if (runProducer) {
        producer = ProducerLoop.buildProducer(Kafka, producer_opts, topicName, shutdown);
        producer.connect();
    }
};
