import * as PM2 from "pm2";
import * as Pmx from "pmx";
import * as Fs from "fs";
import { basename, join, parse } from "path";
import { Mail, ISmtpConfig } from "./Mail";
import { Snapshot, IShapshotConfig, IAuth } from "./Snapshot";
import { Fetch } from "planck-http-fetch";
import { info, error } from "./Log";

const
    MERTIC_INTERVAL_S = 60,
    CONIFG_FETCH_INVERVAL_M = 10,
    HOLD_PERIOD_M = 30,
    LOGS = ["pm_err_log_path", "pm_out_log_path"],
    OP = {
        "<": (a, b) => a < b,
        ">": (a, b) => a > b,
        "=": (a, b) => a === b,
        "<=": (a, b) => a <= b,
        ">=": (a, b) => a >= b,
        "!=": (a, b) => a != b
    },
    CONFIG_KEYS = ["events", "metric", "exceptions", "messages", "messageExcludeExps", "appsExcluded", "metricIntervalS", "addLogs"];

interface IMonitConfig {
    events: string[];
    metric: {
        [key: string]: {
            target?: any;
            op?: "<" | ">" | "=" | "<=" | ">=" | "!=";
            ifChanged?: boolean;
            noHistory?: boolean;
            noNotify: boolean;
            exclude?: boolean;
            direct?: boolean;
        }
    },
    exceptions: boolean;
    messages: boolean;
    messageExcludeExps: string;
    appsExcluded: string[];
    metricIntervalS: number;
    addLogs: boolean;
}

interface IConfig extends IMonitConfig, ISmtpConfig, IShapshotConfig {
    webConfig: {
        url: string;
        auth?: IAuth;
        fetchIntervalM: number;
    }
}

export class Health {
    readonly _mail: Mail;
    readonly _snapshot: Snapshot;
    _holdTill: Date = null;

    constructor(private _config: IConfig) {
        if (this._config.metricIntervalS == null)
            this._config.metricIntervalS = MERTIC_INTERVAL_S;

        if (!this._config.metric)
            this._config.metric = {};

        this._mail = new Mail(_config);
        this._snapshot = new Snapshot(this._config);
    }

    async fetchConfig() {
        try {
            info(`fetching config from [${this._config.webConfig.url}]`);

            let
                fetch = new Fetch(this._config.webConfig.url);
            if (this._config.webConfig.auth && this._config.webConfig.auth.user)  // auth
                fetch.basicAuth(this._config.webConfig.auth.user, this._config.webConfig.auth.password);
            let
                json = await fetch.fetch(),
                config = JSON.parse(json);

            // map config keys
            for (let key of CONFIG_KEYS)
                if (config[key]) {
                    this._config[key] = config[key];
                    info(`applying [${key}]`);
                }

            this.configChanged();
        }
        catch (ex) {
            error(`failed to fetch config -> ${ex.message || ex}`);
        }
    }

    _messageExcludeExps: RegExp[];

    configChanged() {
        this._messageExcludeExps = [];
        if (Array.isArray(this._config.messageExcludeExps))
            this._messageExcludeExps = this._config.messageExcludeExps.map(e => new RegExp(e));
    }

    isAppExcluded(app: string) {
        return app === "pm2-health" || (Array.isArray(this._config.appsExcluded) && this._config.appsExcluded.indexOf(app) !== -1);
    }

    async go() {
        info(`pm2-health is on`);

        this.configChanged();

        // fetch web config (if set)
        if (this._config.webConfig && this._config.webConfig.url) {
            await this.fetchConfig();

            if (this._config.webConfig.fetchIntervalM > 0)
                setInterval(
                    () => {
                        this.fetchConfig();
                    },
                    this._config.webConfig.fetchIntervalM * 60 * 1000);
        }

        PM2.connect((ex) => {
            stopIfEx(ex);

            PM2.launchBus((ex, bus) => {
                stopIfEx(ex);

                bus.on("process:event", (data) => {
                    if (data.manually || this.isAppExcluded(data.process.name))
                        return;

                    if (Array.isArray(this._config.events) && this._config.events.indexOf(data.event) === -1)
                        return;

                    this.mail(
                        `${data.process.name}:${data.process.pm_id} - ${data.event}`,
                        `
                        <p>App: <b>${data.process.name}:${data.process.pm_id}</b></p>
                        <p>Event: <b>${data.event}</b></p>
                        <pre>${JSON.stringify(data, undefined, 4)}</pre>`,
                        LOGS.filter(e => this._config.addLogs === true && data.process[e]).map(e => ({ filename: basename(data.process[e]), path: data.process[e] })));
                });

                if (this._config.exceptions)
                    bus.on("process:exception", (data) => {
                        if (this.isAppExcluded(data.process.name))
                            return;

                        this.mail(
                            `${data.process.name}:${data.process.pm_id} - exception`,
                            `
                            <p>App: <b>${data.process.name}:${data.process.pm_id}</b></p>                            
                            <pre>${JSON.stringify(data.data, undefined, 4)}</pre>`);
                    });

                if (this._config.messages)
                    bus.on("process:msg", (data) => {
                        if (this.isAppExcluded(data.process.name))
                            return;

                        let
                            json = JSON.stringify(data.data, undefined, 4);

                        if (this._messageExcludeExps.some(e => e.test(json)))
                            return; // exclude

                        this.mail(
                            `${data.process.name}:${data.process.pm_id} - message`,
                            `
                            <p>App: <b>${data.process.name}:${data.process.pm_id}</b></p>
                            <pre>${json}</pre>`);
                    });
            });

            this.testProbes();
        });

        Pmx.action("hold", (p, reply) => {
            let
                t = HOLD_PERIOD_M;
            if (p) {
                let
                    n = parseInt(p);
                if (!isNaN(n))
                    t = n;
            }

            this._holdTill = new Date();
            this._holdTill.setTime(this._holdTill.getTime() + t * 60000);

            let
                msg = `mail held for ${t} minutes, till ${this._holdTill.toISOString()}`;
            info(msg);
            reply(msg);
        });

        Pmx.action("unhold", (reply) => {
            this._holdTill = null;
            reply(`mail unheld`);
        });

        Pmx.action("mail", async (reply) => {
            try {
                await this._mail.send("Test only", "This is test only.");
                reply(`mail send`);
            }
            catch (ex) {
                reply(`mail failed: ${ex.message || ex}`);
            }
        });

        Pmx.action("dump", (reply) => {
            this._snapshot.dump();
            reply(`dumping`);
        });

        // for dev. only
        Pmx.action("debug", reply => {
            PM2.list((ex, list) => {
                stopIfEx(ex);

                Fs.writeFileSync(`./pm2-health-debug.json`, JSON.stringify(list), "utf8");

                reply(`dumping`);
            });
        });
    }

    private async mail(subject: string, body: string, attachements = []) {
        let
            t = new Date();
        if (this._holdTill != null && t < this._holdTill)
            return; // skip

        try {
            await this._mail.send(subject, body, attachements);
            info(`mail send: ${subject}`);
        }
        catch (ex) {
            error(`mail failed: ${ex.message || ex}`);
        }
    }

    private testProbes() {
        let
            alerts = [];

        PM2.list((ex, list) => {
            stopIfEx(ex);

            for (let e of list) {
                if (this.isAppExcluded(e.name))
                    continue;

                let
                    monit = e.pm2_env["axm_monitor"];
                if (!monit)
                    monit = {};

                // add memory + cpu metrics
                if (e.monit) {
                    monit["memory"] = { value: e.monit.memory / 1048576 };
                    monit["cpu"] = { value: e.monit.cpu };
                }

                if (e.pm2_env) {
                    if (e.pm2_env["_pm2_version"])
                        monit["pm2"] = { value: e.pm2_env["_pm2_version"], direct: true };

                    if (e.pm2_env["node_version"])
                        monit["node"] = { value: e.pm2_env["node_version"], direct: true };
                }

                for (let key of Object.keys(monit)) {
                    let
                        probe = this._config.metric[key];
                    if (!probe)
                        probe = { noNotify: true, direct: monit[key].direct === true, noHistory: monit[key].direct === true };

                    if (probe.exclude === true)
                        continue;

                    let
                        v = monit[key].value,
                        bad: boolean;

                    if (!probe.direct) {
                        v = Number.parseFloat(v);
                        if (Number.isNaN(v)) {
                            console.error(`monit [${key}] is not a number`);
                            continue;
                        }
                    }

                    if (probe.op && probe.op in OP && probe.target != null)
                        bad = OP[probe.op](v, probe.target);

                    // test
                    if (probe.noNotify !== true && bad === true && (probe.ifChanged !== true || this._snapshot.last(e.pm_id, key) !== v))
                        alerts.push(`<tr><td>${e.name}:${e.pm_id}</td><td>${key}</td><td>${v}</td><td>${this._snapshot.last(e.pm_id, key)}</td><td>${probe.target}</td></tr>`);

                    let
                        data: any = { v }
                    if (bad)    // safe space by not storing false
                        data.bad = true;

                    this._snapshot.push(e.pm_id, e.name, key, !probe.noHistory, data);
                }
            }

            this._snapshot.send();

            if (alerts.length > 0)
                this.mail(
                    `${alerts.length} alert(s)`,
                    `
                    <table>
                        <tr>
                            <th>App</th><th>Metric</th><th>Value</th><th>Prev. Value</th><th>Target</th>
                        </tr>
                        ${alerts.join("")}
                    </table>`);

            setTimeout(
                () => { this.testProbes(); },
                1000 * this._config.metricIntervalS);
        });
    }
}

export function stopIfEx(ex: Error) {
    if (ex) {
        console.error(ex.message || ex);
        PM2.disconnect();
        process.exit(1);
    }
}