;(function() {

    var fs = require('fs');

    /**
    * Load and verify configuration
    */
    var config = (function() {

        try {

            var buff = fs.readFileSync('./config.json');

            var 
                conf = JSON.parse(buff)
                , error = undefined
            ;

            if(!conf.accountSid) {

                error = "Invalid accountSid";
            }
            else if((!conf.numbers) || !conf.numbers.from 
                || !conf.numbers.to) {

                error = "Invalid number parameters";
            }
            else if(!conf.authToken) {

                error = "Invalid authToken";
            }
            else if (!conf.applicationSid) {

                error = "Invalid accountSid";
            }
            else if(!(conf.ports) || !conf.ports.app 
                || !conf.ports.device) {

                error = "Invalid port specified";
            }
            else if (!(conf.codes) || !conf.codes.disarm.value 
                || !conf.codes.disarm.phonetic || !conf.codes.connect.value
                || !conf.codes.connect.phonetic) {

                error = "Invalid codes specified";
            }

            if(error) {

                console.log("config.json: %s\r\n", error);
                process.exit(1);
            }
        }
        catch (e) {

            console.log("config.json: %s\r\n", e);
            process.exit(1);
        }

        return conf;
    })();

    var
        express = require('express') 
        , twilio = require('twilio-api')
        , async = require('async')
        , dnode = require('dnode')
        , net = require('net')
        , app = express.createServer()
        , online = {}           // device controllers online
        , active = {}           // device controllers triggered
        , voiceActive = false   // in a call
        , twapp                 // twilio app
        , cli = new twilio.Client(

            config.accountSid
            , config.authToken
        )
        , server = net.createServer(function(c) {

            var d = dnode({

                heartbeat : heartbeat
                , detection : detection
                , baseline : baseline
            });

            c.pipe(d).pipe(c);
        })
    ;

    app.use(cli.middleware());
    app.listen(config.ports.app);
    server.listen(config.ports.device);

    cli.account.getApplication(config.applicationSid, function(err, twip) {

    	if(err) { 

    		console.log(err);
    		return;
    	}

        twapp = twip;
    	twip.register();

    });

    /**
    * Received baseline measurement
    */
    var baseline = function baseline(id, val, cb) {

        if(!id || typeof cb !== "function") {

            console.log("Invalid ID or callback in baseline");
            return;
        }

        console.log("Received baseline from device: %s", id);
        online[id] = true;
        cb(null, id);
    };

    /**
    * Received heartbeat (status::0)
    */
    var heartbeat = function recordHeartbeat(id, cb) {

        if(!id || typeof cb !== "function") { 

            console.log("Invalid ID or callback in heartbeat");
            return; 
        }

        cb(null, id);
    };

    /**
    * Received detection (status::1)
    */
    var detection = function recordDetection(id, cb) {

        console.log("Received detection from device: %s", id);

        if(!id || typeof cb !== "function") {

            console.log("Invalid ID or callback in detection");
            return;
        }

        active[id] = true;

        if((id) && online[id] && !voiceActive) {

            voiceActive = true;
            console.log("active: Alerting...");

            callEveryone(id, cb);

            return;
        }
        else if(voiceActive) {

            console.log("active: Already on call...");
        }
        else{

            console.log("DEBUG id: %s active: %s voiceActive: %s", id, online[id], voiceActive);
        }

        cb(null, id);
    };

    /**
    * Alert everyone on the call list
    */
    var callEveryone = function callEveryone(id, done) {
        
        var calls = [];

        config.numbers.to.forEach(function(num) {

            calls.push(getCaller(id, num));
        });

        async.parallel(calls, function(err, res) {

            if(err) {

                done(err, undefined);
                console.log(err);
                return;
            }

            console.log(res);
            done(null, res);
        });
    };

    /**
    * Wrap a voiceAlert call with async callbacks
    */
    var getCaller = function getCaller(id, num) {

        return function(cb) {

            voiceAlert(id, num, cb);
        }
    };

    /**
    * Initiate a voice alert
    */
    var voiceAlert = function voiceAlert(id, num, cb) {

        if(!num || !id || typeof cb !== "function") {

            console.log("Invalid voiceAlert parameters.");
            return false;
        }

        console.log("voiceAlert %s %s", id, num);

        /**
        * Get input from the user
        */
        var getDigits = function getDigits(call, cb) {

            return call.gather(cb, {

                timeout : 10
                , numDigits : 3
            }).say([
                "Press"
                , config.codes.disarm.phonetic
                , "to deactivate. Press"
                , config.codes.connect.phonetic
                , "to connect."
                ].join(" ")
            , {

                voice : 'woman'
            });
        };

        /**
        * Check if they are a valid command
        */
        var verifyDigits = function verifyDigits(call, digits) {

            console.log("Digits entered: %s", digits);
            if(digits == config.codes.disarm.value) {

                active[id] = false;

                endCall(call, "The alarm has been deactivated.");
            }
            else if(digits == config.codes.connect.value) {

                joinConference(call);
            }
            else {

                say(call, "I did not recognize your selection.");
                getDigits(call, verifyDigits);
            }            
        };

        /**
        * Excuse the user from the conversation
        */
        var endCall = function endCall(call, message) {

            call.say(
                (message ? message : '') + ' Goodbye.'
                , { voice : 'woman' }
            );
            call.hangup();
        };

        /**
        * Say something with the female voice
        */
        var say = function say(call, message) {

            if((call) && (message)) {

                return call.say(message, {

                    voice : 'woman'
                });
            }
        };

        /**
        * Join the user to the conference (Monitor)
        */

        var joinConference = function joinConference(call) {

            if(!call) { return; }

            say(call, 'Connecting... Press star to disconnect.');
            call.joinConference('orobos', {

                waitUrl : ''
                , leaveOnStar : true
            }, endConference);
        };

        /**
        * The conference has ended
        */
        var endConference = function endConference(call, status) {

            console.log("Conference ended...");
            console.log(status);
        };

        twapp.makeCall(config.numbers.from, num, function(err, call) {

            if(err) throw err;

            call.on('connected', function(status) {

                //Called when the caller picks up
                call.say("The alarm has been triggered!", {

                    voice : 'woman'
                    , loop : 3
                });

                getDigits(call, verifyDigits);

                console.log("Speaking...");
            });

            call.on('ended', function(status, duration) {

                //Called when the call ends
                voiceActive = false;

                /**
                * Alarm was not deactivated
                */
                if(active[id]) {

                    voiceAlert(id, num, cb);
                    return;
                }

                cb(null, status, duration); 
            });
        });    	
    };

})();
