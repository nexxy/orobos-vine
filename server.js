;(function() {

    /**
    * REQUIRES
    */
    var 
        express = require('express') 
        , twilio = require('twilio-api')
        , async = require('async')
        , dnode = require('dnode')
        , path = require('path')
        , net = require('net')
        , fs = require('fs')
    ;

    /**
    * UTILITY STUFFS
    */
    var log = function() {

        var 
            d = (new Date()).toLocaleString()
            , format = arguments[0]
        ;

        delete arguments[0];
        console.log(

            ["[", d, "] ", format].join('')
            , arguments
        );
    };

    /**
    * Load and verify configuration
    */
    var config = (function() {

        try {

            var buff = fs.readFileSync(path.resolve(__dirname, 'config.json'));
            var 
                conf = JSON.parse(buff)
                , error = undefined
            ;

            if(!conf.accountSid) {

                error = "Invalid accountSid";
            }
            else if(!conf.authToken) {

                error = "Invalid authToken";
            }
            else if (!conf.applicationSid) {

                error = "Invalid accountSid";
            }
            else if((!conf.number) || !conf.number.from 
                || !conf.number.to) {

                error = "Invalid number parameters";
            }
            else if(!(conf.port) || !conf.port.app 
                || !conf.port.device) {

                error = "Invalid ports specified";
            }
            else if (!(conf.code) || (!conf.code.deactivate) || (!conf.code.activate)
                || (!conf.code.connect) || !conf.code.connect.phonetic || !conf.code.connect.value
                || !conf.code.deactivate.value || !conf.code.deactivate.phonetic 
                || !conf.code.connect.value || !conf.code.connect.phonetic) {

                error = "Invalid codes specified";
            }
            else if((!conf.prompt) || !conf.prompt.passcode
                || !conf.prompt.trigger || !conf.prompt.conference
                || !conf.prompt.activate || !conf.prompt.deactivate) {

                error = "Invalid prompts specified";
            }
            else if((!conf.response) || !conf.response.activated
                || !conf.response.deactivated || !conf.response.unrecognized
                || !conf.response.invalid) {

                error = "Invalid responses specified.";
            }
            else if ((!conf.status) || !conf.status.phrase 
                || !conf.status.active || !conf.status.inactive) {

                error = "Invalid status specified."
            }
            if(error) {

                log("config.json: %s\r\n", error);
                process.exit(1);
            }
        }
        catch (e) {

            log("config.json: %s\r\n", e);
            process.exit(1);
        }

        return conf;
    })();

    /**
    * BOOTSTRAP
    */
    var
        app = express.createServer()
        , online = {}           // device controllers online
        , active = {}           // device controllers triggered
        , currentCalls = 0      // calls in progress
        , voiceActive = false   // in a call
        , alarmActive = true   // system is active (will make calls on alarms)
        , alarmCheck = undefined
        , twapp                 // twilio app
        , cli = new twilio.Client(

            config.accountSid
            , config.authToken
        )
        , fem = { "voice" : "woman" }
        , server = net.createServer(function(c) {

            var d = dnode(DeviceInterface);

            c.pipe(d).pipe(c);
        })
    ;

    app.use(cli.middleware());
    app.listen(config.port.app);
    server.listen(config.port.device);

    var DeviceInterface = {

        heartbeat : function heartbeat(id, cb) {

            if(!id || typeof cb !== "function") { 

                log("Invalid ID or callback in heartbeat");
                cb("invalid id/callback");
                return; 
            }

            cb(null, id);
        }
        , detection : function detection(id, stat, cb) {

            log("Received detection from device: %s, type: ", id, stat ? "lost USB" : "triggered");
            
            if(!activeTime()) {

                cb(null, id);
                return;
            }
            
            if(!id || typeof cb !== "function") {

                log("Invalid ID or callback in detection");
                return;
            }

            active[id] = true;

            if((id) && online[id] && !voiceActive && (alarmActive)) {

                voiceActive = true;
                callEveryone(id, cb);

                return;
            }
            else if(voiceActive) {

                cb(null, id);
            }
            else if(!alarmActive) {

                log("Received detection from device %s, system is not active.", id);
            }
            else{

                log("DEBUG id: %s active: %s voiceActive: %s", id, online[id], voiceActive);
            }

            cb(null, id);
        }
        , register : function register(id, cb) {

            if(typeof cb !== "function") { return; }

            this.registered = (new Date()).valueOf();

            if(id) {

                online[id] = true;
                cb(null, id);
            }
            else {

                log("Device attempted to register with invalid device ID.");
                cb(new Error("Invalid device ID"), null);
                return;
            }
        }
    };

    var app = function app(err, twip) {

        if(err) { 

            log(err);
            process.exit(1);
            return;
        }

        twapp = twip;

        var callPasscode = function callPasscode(call, cb) {

            return call.gather(cb, { 

                numDigits : codes.passcode.length
                , timeout : config.responseTimeout 
            }).say(config.prompt.passcode, fem);
        };

        var callDeactivate = function callDeactivate(call, cb) { 

            var code = config.code.deactivate.value;

            return call.gather(cb, { 

                numDigits : code.length
                , timeout : config.responseTimeout 
            }).say(config.prompt.deactivate, fem);
        };

        var callActivate = function callActivate(call, cb) {

            var 
                codeVal = config.code.activate.value
                , codePhon = conf.code.activate.phonetic
                , spoken = config.prompt.activate.replace('%s', codePhon)
            ;

            return call.gather(cb, { 

                numDigits : codeVal.length
                , timeout : config.responseTimeout 
            }).say(spoken, fem);
        };

        var verifyDeactivate = function verifyDeactivate(call, digits) {

            if(digits == config.code.deactivate.value) {

                call.say(config.response.deactivated, fem);
                call.hangup();
                deactivate();
            }
            else {

                call.say(config.response.unrecognized, fem);
                callDeactivate(call, verifyDeactivate);
            }
        };

        var verifyActivate = function verifyActivate(call, digits) {

            if(digits == config.code.activate.value) {

                call.say(config.response.activated, fem);
                call.hangup();
                activate();
            }
            else {
                
                call.say(config.response.unrecognized, fem);
                callActivate(call, verifyActivate);
            }
        };

        var verifyPasscode = function verifyPasscode(call, digits) {

            if(digits != config.code.passcode) {

                call.say(config.response.invalid, fem);
                callPasscode(call, verifyPasscode);
                return;
            }

            var 
                systemStatus = config.status[
                    alarmActive ? "active" : "inactive"
                ]
                , spoken = config.status.phrase.replace('%s', systemStatus)
            ;

            call.say(config.response.authed, fem);
            call.say(spoken, fem);

            if(alarmActive) {

                callDeactivate(call, verifyDeactivate);
            }
            else {

                callActivate(call, verifyActivate);
            }
        };

        var incomingCall = function incomingCall(call) {

            callPasscode(call, verifyPasscode);
        };

        twip.on('incomingCall', incomingCall);
        twip.register();
    };

    cli.account.getApplication(config.applicationSid, app);

    /**
    * Activated schedule hack 
    * TODO: make this configurable.
    */
    var activeTime = function activeTime() {

        return true;
        var hour = (new Date()).getHours();

        if(hour >= 3 && hour <= 11) {

            if(!alarmActive) {

                log("Alarm is now active.");
            }

            alarmActive = true;
            return true;
        }
        if(alarmActive) {

            log("Alarm is now inactive.");
        }
        alarmActive = false;
        return false;
    };

    /**
    * Deactivate the alarm and reset the watch timer
    */
    var deactivate = function deactivate() {

        alarmActive = false;
        alarmWatch();
    };

    var activate = function activate() {

        alarmActive = true;
        alarmWatch();
    };

    /**
    * Restart the watch timer (one hour)
    */
    var alarmWatch = function alarmWatch() {

        clearInterval(alarmCheck);
        alarmCheck = setInterval(activeTime, 60*60*1000);
    }

    /**
    * Alert everyone on the call list
    */
    var callEveryone = function callEveryone(id, done) {
        
        var calls = [];
        config.number.to.forEach(function(num) {

            calls.push(getCaller(id, num));
        });

        async.parallel(calls, function(err, res) {

            if(err) {

                done(err, undefined);
                log(err);
                return;
            }

            log(res);
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

            log("Invalid voiceAlert parameters.");
            return false;
        }

        log("Calling %s due to trigger from %s", num, id);

        /**
        * Get input from the user
        */
        var getDigits = function getDigits(call, cb) {

            var 
                digits = config.code.deactivate.value.length
                , spoken = config.prompt.deactivate
                    .replace(config.code.deactivate.phonetic)
            ;

            log("Prompting %s to enter selection...");
            return call.gather(cb, {

                timeout : config.responseTimeout
                , numDigits : digits
            }).say(spoken, fem);
        };

        /**
        * Check if they are a valid command
        */
        var verifyDigits = function verifyDigits(call, digits) {

            log("%s entered digits: %s", num, digits);

            /**
            * User has disarmed the alarm
            */
            if(digits == config.code.deactivate.value) {

                log("%s has deactivated the alarm.", num);
                deactivate();
                endCall(call, config.response.deactivated);
            }
            else if(digits == config.code.connect.value) {

                log("%s is joining the conference...", num);
                joinConference(call);  
            }
            else {

                log("%s entered an unrecognized selection.", num);
                say(call, config.response.unrecognized);
                getDigits(call, verifyDigits);
            }            
        };

        /**
        * Excuse the user from the conversation
        */
        var endCall = function endCall(call, message) {

            call.say(
                (message ? message : '') + config.response.hangup
                , fem
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

            say(call, config.response.connecting);
            call.joinConference('orobos', {

                waitUrl : ''
                , leaveOnStar : true
            }, endConference);
        };

        /**
        * Called when the conference has ended
        */
        var endConference = function endConference(call, status) {

            log("Conference ended with status: %s.", status);
        };

        twapp.makeCall(config.number.from, num, function(err, call) {

            if(err) throw err;

            currentCalls++;
            call.on('connected', function(status) {

                //Called when the caller picks up
                getDigits(call, verifyDigits);
                log("Call with %s connected. Notifying user of alarm from %s.", num, id);
            });

            call.on('ended', function(status, duration) {

                log("Call with %s has ended after %s seconds (%s).", num, duration, status);

                /**
                * No more calls active
                */
                if(--currentCalls <= 0) {

                    voiceActive = false;
                    currentCalls = 0;
                    log("All calls have ended.");
                }

                /**
                * Alarm was not deactivated, call again.
                * TODO: add a maximum retry limit.
                */
                if(alarmActive) {

                    voiceAlert(id, num, cb);
                    log("Alarm still active, recalling %s.", num);
                    return;
                }

                cb(null, status, duration); 
            });
        });    	
    };

    alarmWatch();

})();
