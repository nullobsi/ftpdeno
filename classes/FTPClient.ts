import {ConnectionOptions, IntConnOpts} from "../types/ConnectionOptions.ts";
import {Commands, StatusCodes, Types} from "../util/enums.ts";
import Lock from "./Lock.ts";
import * as Regexes from "../util/regexes.ts";
import free from "../util/free.ts";
import { iterateReader } from "https://deno.land/std@0.161.0/streams/conversion.ts";

export class FTPClient implements Deno.Closer {
    private conn?: Deno.Conn;
    private dataConn?: Deno.Conn;
    private activeListener?: Deno.Listener;

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
                n.tlsOpts = {
                    hostname: opts.tlsOpts.hostname ? opts.tlsOpts.hostname : host,
                    caCerts: opts.tlsOpts.caCerts,
                    implicit: opts.tlsOpts.implicit === undefined ? false : opts.tlsOpts.implicit
                };
            }
        }
        this.opts = n;
    }

    /**
     * Initialize connection to server.
     */
    public async connect() {
        this.conn = await Deno.connect({
            hostname: this.host,
            port: this.opts.port,
        });

        let status = await this.getStatus();
        this.assertStatus(StatusCodes.Ready, status);

        //handle TLS handshake
        if (this.opts.tlsOpts) {
            if (!this.opts.tlsOpts.implicit) {
                status = await this.command(Commands.Auth, "TLS");
                this.assertStatus(StatusCodes.AuthProceed, status, this.conn);
            }

            //replace connection with tls
            this.conn = await Deno.startTls(this.conn, {
                hostname: this.opts.tlsOpts.hostname,
                caCerts: this.opts.tlsOpts.caCerts,
            });

            //switch data channels to TLS
            status = await this.command(Commands.Protection, "P");
            this.assertStatus(StatusCodes.OK, status, this.conn);
        }

        status = await this.command(Commands.User, this.opts.user);
        if (status.code != StatusCodes.LoggedIn) {
            this.assertStatus(StatusCodes.NeedPass, status, this.conn);

            status = await this.command(Commands.Password, this.opts.pass);
            this.assertStatus(StatusCodes.LoggedIn, status, this.conn);
        }

        //Switch to binary mode
        status = await this.command(Commands.Type, Types.Binary);
        this.assertStatus(StatusCodes.OK, status, this.conn);
    }

    private static notInit() {
        return new Error("Connection not initialized!");
    }

    private static async recieve(reader: Deno.Reader) {
        // use async iterator to write chunks to data array
        const iter = iterateReader(reader);
        let data = new Uint8Array();
        for await (const chunk of iter) {
            const n = new Uint8Array(data.byteLength + chunk.byteLength);
            n.set(data);
            n.set(chunk, data.byteLength);
            data = n;
        }
        return data;
    }

    /**
     * Current Working Directory `pwd`
     */
    public async cwd() {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }
        const res = await this.command(Commands.PWD);
        this.lock.unlock();
        if (res.code !== 257) {
            return {
                result: null,
                ...res,
            }
        }
        const r = Regexes.path.exec(res.message);
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

    /**
     * `cd` like command
     */
    public async chdir(path: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }
        const res = await this.command(Commands.CWD, path);
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

    /**
     * Like `cd ..`
     */
    public async cdup() {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }
        const res = await this.command(Commands.CdUp);
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

    /**
     * Download a file from the server.
     * @param fileName
     */
    public async download(fileName: string) {
        const conn = await this.downloadStream(fileName);
        const data = await FTPClient.recieve(conn);
        await this.finalizeStream();

        return data;
    }

    /**
     * Download a file from the server with streaming.
     * **Please call FTPClient.finalizeStream()** to release the lock after the file is done downloading.
     * @param fileName
     */
    public async downloadStream(fileName: string): Promise<Deno.Reader> {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }
        await this.initializeDataConnection();

        const res = await this.command(Commands.Retrieve, fileName);
        this.assertStatus(StatusCodes.StartTransferConnection, res, this.dataConn, this.activeListener);

        return await this.finalizeDataConnection();
    }

    /**
     * Upload a file to the server.
     * @param fileName
     * @param data
     */
    public async upload(fileName: string, data: Uint8Array) {
        const conn = await this.uploadStream(fileName, data.byteLength);
        let written = await conn.write(data);
        const maxSize = written;
        for (let i = 0; i < data.byteLength / maxSize; i++)
          written += await conn.write(data.slice(written));
        await this.finalizeStream();
        return written;
    }

    /**
     * Upload a file to the server, with streaming.
     * **Please call FTPClient.finalizeStream()** to release the lock after the file is done downloading.**
     * @param fileName
     * @param allocate Number of bytes to allocate to the file. Some servers require this parameter.
     */
    public async uploadStream(fileName: string, allocate?: number) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock()
            throw FTPClient.notInit();
        }

        await this.initializeDataConnection();

        if (allocate !== undefined) {
            const res = await this.command(Commands.Allocate, allocate.toString());
            if (res.code !== 202 && res.code !== 200) {
                this.assertStatus(StatusCodes.OK, res, this.activeListener, this.dataConn);
            }
        }

        const res = await this.command(Commands.Store, fileName);
        this.assertStatus(StatusCodes.StartTransferConnection, res, this.dataConn, this.activeListener);

        return await this.finalizeDataConnection();
    }


    /**
     * Unlock and close connections for streaming.
     */
    public async finalizeStream() {
        free(this.dataConn);

        const res = await this.getStatus();
        this.assertStatus(StatusCodes.DataClose, res);

        this.lock.unlock();
    }

    //naive way of doing this but there isn't really another way that works on everything
    //TODO: use feat command and use MLST if available
    /**
     * Obtain file information from the FTP server.
     * @param filename
     */
    public async stat(filename: string): Promise<Deno.FileInfo> {
        let retn: Deno.FileInfo = {
            atime: null,
            birthtime: null,
            blksize: null,
            blocks: null,
            dev: null,
            gid: null,
            ino: null,
            mode: null,
            nlink: null,
            rdev: null,
            uid: null,

            mtime: null,
            isSymlink: false,
            isFile: true,
            isDirectory: false,
            size: 0
        }


        try {
            retn.size = await this.size(filename);
        } catch (e) {
            if (e.code !== 550) {
                throw e;
            } else {
                retn.isDirectory = true;
                retn.isFile = false;
            }
        }

        if (retn.isFile) {
            retn.mtime = await this.modified(filename);
        }

        return retn;
    }

    /**
     * Get file size in bytes
     * @param filename
     */
    public async size(filename: string): Promise<number> {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }

        let res = await this.command(Commands.Size, filename);
        this.assertStatus(StatusCodes.FileStat, res);

        this.lock.unlock();
        return parseInt(res.message);
    }

    /**
     * Get file modification time.
     * @param filename
     */
    public async modified(filename: string): Promise<Date> {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }

        let res = await this.command(Commands.ModifiedTime, filename);
        this.assertStatus(StatusCodes.FileStat, res);
        this.lock.unlock();

        let parsed = Regexes.mdtmReply.exec(res.message);
        if (parsed && parsed.groups) {
            console.log(parsed.groups);
            let year = parseInt(parsed.groups.year);
            let month = parseInt(parsed.groups.month);
            let day = parseInt(parsed.groups.day);
            let hour = parseInt(parsed.groups.hour);
            let minute = parseInt(parsed.groups.minute);
            let second = parseInt(parsed.groups.second);
            let ms = parsed.groups.ms;
            let date = new Date(year, month, day, hour, minute, second);
            if (ms !== undefined) {
                let n = parseFloat(ms);
                date.setMilliseconds(n*1000);
            }
            return date;
        } else {
            throw res;
        }
    }


    /**
     * Rename a file on the server.
     * @param from
     * @param to
     */
    public async rename(from: string, to: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit();
        }

        let res = await this.command(Commands.RenameFrom, from);
        this.assertStatus(StatusCodes.NeedFileInfo, res);

        res = await this.command(Commands.RenameTo, to);
        this.assertStatus(StatusCodes.ActionOK, res);

        this.lock.unlock();
        return true;
    }

    /**
     * Remove a file on the server.
     * @param fileName
     */
    public async rm(fileName: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit()
        }

        let res = await this.command(Commands.Delete, fileName);
        this.assertStatus(StatusCodes.ActionOK, res);

        this.lock.unlock();
    }

    /**
     * Remove a directory on the server.
     * @param dirName
     */
    public async rmdir(dirName: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit()
        }

        let res = await this.command(Commands.RMDIR, dirName);
        this.assertStatus(StatusCodes.ActionOK, res);

        this.lock.unlock();
    }

    /**
     * Create a directory on the server.
     * @param dirName
     */
    public async mkdir(dirName: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit()
        }

        let res = await this.command(Commands.MKDIR, dirName);
        this.assertStatus(StatusCodes.DirCreated, res);

        this.lock.unlock();
        return true;
    }

    /**
     * Retrieve a directory listing from the server.
     * @param dirName Directory of listing (default cwd)
     */
    public async list(dirName?: string) {
        await this.lock.lock();
        if (this.conn === undefined) {
            this.lock.unlock();
            throw FTPClient.notInit()
        }

        await this.initializeDataConnection();

        let res = await this.command(Commands.List, dirName);
        this.assertStatus(StatusCodes.StartTransferConnection, res, this.dataConn, this.activeListener)

        let conn = await this.finalizeDataConnection();
        let data = await FTPClient.recieve(conn);
        free(conn);

        res = await this.getStatus();
        this.assertStatus(StatusCodes.DataClose, res);

        this.lock.unlock();

        let listing = this.decode.decode(data);
        listing = listing.trimEnd()

        return listing.split("\r\n");
    }

    /**
     * Please call this function when you are done to avoid loose connections.
     */
    public async close() {
        await this.lock.lock();
        free(this.conn);
        free(this.activeListener);
        free(this.dataConn);
        this.lock.unlock();
    }

    // execute an FTP command
    private async command(c: Commands, args?: string) {
        if (!this.conn) {
            throw new Error("Connection not initialized!");
        }
        let encoded = this.encode.encode(`${c.toString()}${args ? " " + args : ""}\r\n`)
        await this.conn.write(encoded);
        return await this.getStatus();

    }

    //parse response from FTP control channel
    private async getStatus() {
        if (!this.conn) throw FTPClient.notInit();

        let s = "";
        let iter = iterateReader(this.conn);

        for await (let a of iter) {
            let decoded = this.decode.decode(a);
            s += decoded;
            if (s[3] !== '-') {
                if (s.endsWith("\r\n")) {
                    break;
                }
            } else {
                let i = s.lastIndexOf("\r\n");
                if (i !== -1) {
                    let pi = s.lastIndexOf("\r\n", i - 1);
                    let lastLine = s.substring(pi + 2, i);
                    if (lastLine.startsWith(s.substr(0,3))) {
                        break;
                    }
                }
            }

        }
        let statusCode = parseInt(s.substr(0, 3));
        let message = s.length > 3 ? s.substr(4).trimEnd() : "";

        return {
            code: statusCode,
            message: message,
        };

    }


    // initialize data connections to server
    private async initializeDataConnection() {
        if (this.opts.mode === "passive") {
            let res = await this.command(Commands.PassiveConn);

            this.assertStatus(StatusCodes.ExtendedPassive, res);

            let parsed = Regexes.passivePort.exec(res.message);
            if (parsed === null || parsed.groups === undefined) throw res;
            this.dataConn = await Deno.connect({
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
            this.activeListener = listener;

            let res = await this.command(Commands.ActiveConn, `|${this.opts.activeIpv6 ? "2" : "1"}|${this.opts.activeIp}|${this.opts.activePort}|`);

            this.assertStatus(StatusCodes.OK, res, listener);
        }
    }

    // finalize connection for active and initiate TLS handshake if needed.
    private async finalizeDataConnection() {
        if (this.opts.mode == "active") {
            this.dataConn = await this.activeListener?.accept();
            free(this.activeListener);
        }
        if (this.dataConn === undefined) throw new Error("Could not initialize data connection!");
        if (this.opts.tlsOpts)
            this.dataConn = await Deno.startTls(this.dataConn, {
                caCerts: this.opts.tlsOpts.caCerts,
                hostname: this.opts.tlsOpts.hostname,
            });
        return this.dataConn;
    }

    // check status or throw error
    private assertStatus(expected: StatusCodes, result: { code: number, message: string }, ...resources: (Deno.Closer | undefined)[]) {
        if (result.code !== expected) {
            let errors: any[] = [];
            resources.forEach(v => {
                if (v !== undefined) {
                    try {
                        free(v);
                    } catch (e) {
                        errors.push(e);
                    }
                }
            });
            this.lock.unlock();
            throw {...result, errors};
        }
    }
}
