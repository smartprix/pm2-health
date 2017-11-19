"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Mailer = require("nodemailer");
const Fs = require("fs");
const os_1 = require("os");
class Mail {
    constructor(_config) {
        this._config = _config;
        this._template = "<p><!-- body --></p><p><!-- timeStamp --></p>";
        if (!this._config.smtp)
            throw new Error(`[smtp] not set`);
        if (!this._config.smtp.host)
            throw new Error(`[smtp.host] not set`);
        if (!this._config.smtp)
            throw new Error(`[smtp.port] not set`);
        if (!this._config.mailTo)
            throw new Error(`[mailTo] not set`);
        try {
            this._template = Fs.readFileSync("Template.html", "utf8");
        }
        catch (_a) {
            console.log(`Template.html not found`);
        }
    }
    async send(subject, body, attachements = []) {
        let temp = {
            host: this._config.smtp.host,
            port: this._config.smtp.port,
            auth: null
        };
        if (this._config.smtp.user)
            temp.auth = {
                user: this._config.smtp.user,
                pass: this._config.smtp.password
            };
        let transport = Mailer.createTransport(temp);
        await transport.sendMail({
            to: this._config.mailTo,
            from: this._config.smtp.user,
            replyTo: this._config.replyTo,
            subject: `pm2-health: ${os_1.hostname()}, ${subject}`,
            html: this._template
                .replace(/<!--\s*body\s*-->/, body)
                .replace(/<!--\s*timeStamp\s*-->/, new Date().toISOString()),
            attachments: attachements
        });
    }
}
exports.Mail = Mail;
//# sourceMappingURL=Mail.js.map