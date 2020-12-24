import {ConnectionOptions, IntConnOpts} from "../types/ConnectionOptions.ts";
import {Commands, StatusCodes, Types} from "../util/enums.ts";
import Lock from "./Lock.ts";
import * as Regexes from "../util/regexes.ts";

class FTPClient {
    private conn?: Deno.Conn;

    private opts: IntConnOpts;
    private encode = new TextEncoder();
    private decode = new TextDecoder();

    private lock = new Lock();

    constructor(readonly host: string, opts?: ConnectionOptions) {
        let n: IntConnOpts = {
            mode: "passive",
            user: "anonymous",
            pass: "anonymous",
            port: 21,
            activePort: 20,
            activeIp: "127.0.0.1",
            activeIpv6: false,
            tlsOpts: undefined,
        };

        if (opts) {
            if (opts.mode) {
                n.mode = opts.mode;
            }
            if (opts.pass) {
                n.pass = opts.pass;
            }
            if (opts.port !== undefined) {
                n.port = opts.port;
            }
            if (opts.user) {
                n.user = opts.user;
            }
            if (opts.activePort !== undefined) {
                n.activePort = opts.activePort;
            }
            if (opts.activeIp) {
                n.activeIp = opts.activeIp;
            }
            if (opts.tlsOpts) {
                let tlsO = {
                    hostname: opts.tlsOpts.hostname ? opts.tlsOpts.hostname : host,
                    certFile: opts.tlsOpts.certFile,
                    implicit: opts.tlsOpts.implicit === undefined ? false : opts.tlsOpts.implicit
                }
                n.tlsOpts = tlsO;
            }
        }
        this.opts = n;
    }

    private static notInit() {
        return new Error("Connection not initialized!");
    }

    private static async recieve(reader: Deno.Reader) {
        let iter = Deno.iter(reader);
        let data = new Uint8Array();
        for await (let chunk of iter) {
            let n = new Uint8Array(data.byteLength + chunk.byteLength);
            n.set(data);
            n.set(chunk, data.byteLength);
            data = n;
        }
        return data;
    }

    public async connect() {
        this.conn = await Deno.connect({
            hostname: this.host,
            port: this.opts.port,
        });

        let status = await this.getStatus();
        if (status.code !== StatusCodes.Ready) {
            throw status;
        }

        if (this.opts.tlsOpts) {
            if (!this.opts.tlsOpts.implicit) {
                status = await this.command(Commands.Auth, "TLS");
                if (status.code !== 234) {
                    this.conn.close();
                    throw status;
                }
            }
            let tlsConn = await Deno.startTls(this.conn, {
                hostname: this.opts.tlsOpts.hostname,
                certFile: this.opts.tlsOpts.certFile,
            });
            this.conn = tlsConn;

            status = await this.command(Commands.Protection, "P");
            if (status.code !== 200) {
                this.conn.close();
                throw status;
            }
        }

        status = await this.command(Commands.User, this.opts.user);
        if (status.code !== StatusCodes.NeedPass) {
            throw status;
        }

        status = await this.command(Commands.Password, this.opts.pass);

        if (status.code !== 230) {
            throw status;
        }

        status = await this.command(Commands.Type, Types.Binary);

        if (status.code !== 200) {
            throw status;
        }

        return;
    }

    public async cwd() {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }
        let res = await this.command(Commands.PWD);
        this.lock.unlock();
        if (res.code !== 257) {
            return {
                result: null,
                ...res,
            }
        }
        let r = Regexes.path.exec(res.message);
        if (r === null) {
            return {
                result: null,
                ...res,
            }
        }
        return {
            result: r[1],
            ...res,
        };
    }

    public async chdir(path: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }
        let res = await this.command(Commands.CWD, path);
        this.lock.unlock();
        if (res.code !== 250) {
            return {
                result: false,
                ...res
            };
        }
        return {
            result: true,
            ...res,
        }
    }

    public async cdup() {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }
        let res = await this.command(Commands.CdUp);
        this.lock.unlock();
        if (res.code !== 250) {
            return {
                result: false,
                ...res
            };
        }
        return {
            result: true,
            ...res,
        }
    }

    public async download(fileName: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }
        let conn = await this.initializeDataConnection();
        let res = await this.command(Commands.Retrieve, fileName);

        if (res.code !== 150) {
            conn.close();
            this.lock.unlock();
            throw res;
        }

        conn = await this.dataHandshake(conn);

        let data = await FTPClient.recieve(conn);
        conn.close();

        res = await this.getStatus();
        if (res.code !== 226) {
            conn.close();
            this.lock.unlock();
            throw res;
        }

        this.lock.unlock();
        return data;

    }

    public async upload(fileName: string, data: Uint8Array) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock()
            throw FTPClient.notInit();
        }
        let conn = await this.initializeDataConnection();

        let res = await this.command(Commands.Allocate, data.byteLength.toString());


        if (res.code !== 202 && res.code !== 200) {
            this.lock.unlock();
            conn.close();
            throw res;
        }


        res = await this.command(Commands.Store, fileName);
        if (res.code !== 150) {
            this.lock.unlock();
            conn.close()
            throw res;
        }

        conn = await this.dataHandshake(conn);
        let written = await conn.write(data);
        conn.close();
        let code = await this.getStatus();
        if (code.code !== 226) {
            this.lock.unlock();
            throw code;
        }
        this.lock.unlock();
        return written;
    }

    public async rename(from: string, to: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }

        let res = await this.command(Commands.RenameFrom, from);
        if (res.code !== 350) {
            this.lock.unlock();
            throw res;
        }
        res = await this.command(Commands.RenameTo, to);
        if (res.code !== 250) {
            this.lock.unlock();
            throw res;
        }
        this.lock.unlock();
        return true;
    }

    public async rm(fileName: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit()
        }

        let res = await this.command(Commands.Delete, fileName);

        if (res.code !== 250) {
            this.lock.unlock();
            throw res;
        }

        this.lock.unlock();
        return true;
    }

    public async rmdir(dirName: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit()
        }

        let res = await this.command(Commands.RMDIR, dirName);

        if (res.code !== 250) {
            this.lock.unlock();
            throw res;
        }

        this.lock.unlock();
        return true;
    }

    public async mkdir(dirName: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit()
        }

        let res = await this.command(Commands.MKDIR, dirName);

        if (res.code !== 257) {
            this.lock.unlock();
            throw res;
        }

        this.lock.unlock();
        return true;
    }

    public async list(dirName?: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit()
        }

        let conn = await this.initializeDataConnection();

        let res = await this.command(Commands.List, dirName);


        if (res.code !== 150) {
            this.lock.unlock();
            conn.close();
            throw res;
        }

        conn = await this.dataHandshake(conn);
        let data = await FTPClient.recieve(conn);
        conn.close();

        res = await this.getStatus();
        if (res.code !== 226) {
            conn.close();
            this.lock.unlock();
            throw res;
        }

        let listing = this.decode.decode(data);
        listing = listing.trimEnd()
        let arr = listing.split("\r\n");

        this.lock.unlock();
        return arr;
    }

    public async close() {
        await this.lock.lock();
        if (this.conn) {
            await this.command(Commands.Quit);
            this.conn.close();
        }
        this.lock.unlock();
    }

    private async command(c: Commands, args?: string) {
        if (!this.conn) {
            throw new Error("Connection not initialized!");
        }
        let encoded = this.encode.encode(`${c.toString()}${args ? " " + args : ""}\r\n`)
        await this.conn.write(encoded);
        return await this.getStatus();

    }

    private async getStatus() {
        if (!this.conn) throw FTPClient.notInit();

        let s = "";
        let iter = Deno.iter(this.conn);

        for await (let a of iter) {
            let decoded = this.decode.decode(a);
            s += decoded;
            if (s.endsWith("\r\n")) {
                break;
            }
        }
        let statusCode = parseInt(s.substr(0, 3));
        let message = s.length > 3 ? s.substr(4).trimEnd() : "";

        return {
            code: statusCode,
            message: message,
        };

    }

    private async initializeDataConnection() {
        let conn: Deno.Conn;
        if (this.opts.mode === "passive") {
            let res = await this.command(Commands.PassiveConn);
            if (res.code !== 229) {
                throw res;
            }
            let parsed = Regexes.passivePort.exec(res.message);
            if (parsed === null || parsed.groups === undefined) throw res;
            conn = await Deno.connect({
                port: parseInt(parsed.groups.port),
                hostname: this.host,
                transport: "tcp",
            });
        } else {
            let listener = await Deno.listen(
                {
                    transport: "tcp",
                    hostname: this.opts.activeIp,
                    port: this.opts.activePort,
                }
            );

            let res = await this.command(Commands.ActiveConn, `|${this.opts.activeIpv6 ? "2" : "1"}|${this.opts.activeIp}|${this.opts.activePort}|`);
            if (res.code !== 200) {
                listener.close();
                throw res;
            }
            conn = await listener.accept();
            listener.close();
        }


        return conn;
    }

    private async dataHandshake(conn: Deno.Conn) {
        if (this.opts.tlsOpts === undefined) return conn;
        return await Deno.startTls(conn, {
            certFile: this.opts.tlsOpts.certFile,
            hostname: this.opts.tlsOpts.hostname,
        });
    }


}

export default FTPClient;