import { ConnectionOptions, IntConnOpts } from "../types/ConnectionOptions.ts";
import { Commands, StatusCodes, Types } from "../util/enums.ts";
import Lock from "./Lock.ts";
import * as Regexes from "../util/regexes.ts";
import free from "../util/free.ts";
import { FeatMatrix, FEATURES } from "../types/FeatMatrix.ts";
import {
	toArrayBuffer,
	toText,
	TextLineStream,
} from "https://deno.land/std@0.210.0/streams/mod.ts";
import { FTPFileInfo } from "../types/FTPFileInfo.ts";
import FTPReply from "../types/FTPReply.ts";

export class FTPClient implements AsyncDisposable, Disposable {
	private conn?: Deno.Conn;
	private connLineReader?: ReadableStream<string>;

	private dataConn?: Deno.Conn;

	private activeListener?: Deno.Listener;

	private opts: IntConnOpts;
	private encode = new TextEncoder();

	private feats: FeatMatrix;

	private lock = new Lock();

	constructor(readonly host: string, opts?: ConnectionOptions) {
		this.feats = {} as FeatMatrix;
		const n: IntConnOpts = {
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
					hostname: opts.tlsOpts.hostname
						? opts.tlsOpts.hostname
						: host,
					caCerts: opts.tlsOpts.caCerts,
					implicit: opts.tlsOpts.implicit === undefined
						? false
						: opts.tlsOpts.implicit,
				};
			}
		}
		this.opts = n;
	}

	// Not sure if implementing both is the way to go...
	[Symbol.dispose](): void {
		this.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	private static notInit() {
		return new Error("Connection not initialized!");
	}

	/**
	 * Initialize connection to server.
	 */
	public async connect() {
		this.conn = await Deno.connect({
			hostname: this.host,
			port: this.opts.port,
		});

		// 1. Wait for server hello message
		let status = await this.getStatus();
		this.assertStatus(StatusCodes.Ready, status);

		// 2. Discover features
		status = await this.command(Commands.Features);

		const discoveredFeats = status.message.split("\r\n").map((a) =>
			a.trim()
		);
		this.feats = Object.fromEntries(
			FEATURES.map((feat) => [feat, discoveredFeats.includes(feat)]),
		) as FeatMatrix;

		let mlst = discoveredFeats.find((v) => v.startsWith("MLST"));
		if (mlst) {
			mlst = mlst.replace("MLST ", "");
			this.feats.MLST = mlst.split(";");
		} else {
			this.feats.MLST = false;
		}

		let auth = discoveredFeats.find((v) => v.startsWith("AUTH"));
		if (auth) {
			auth = auth.replace("AUTH ", "");
			// TODO: is this right
			this.feats.AUTH = auth.split(" ");
		} else {
			this.feats.AUTH = false;
		}

		let rest = discoveredFeats.find((v) => v.startsWith("REST"));
		if (rest) {
			rest = rest.replace("REST ", "");
			this.feats.REST = rest.split(" ");
		} else {
			this.feats.REST = false;
		}

		// 3. If requested, handle TLS handshake
		if (this.opts.tlsOpts) {
			if (!this.opts.tlsOpts.implicit) {
				if (!this.feats.AUTH || !this.feats.AUTH.includes("TLS")) {
					console.warn(
						"Server does not advertise STARTTLS yet it was requested.\nAttempting anyways...",
					);
				}
				status = await this.command(Commands.Auth, "TLS");
				this.assertStatus(StatusCodes.AuthProceed, status, this.conn);
			}

			//replace connection with tls
			this.conn = await Deno.startTls(this.conn, {
				hostname: this.opts.tlsOpts.hostname,
				caCerts: this.opts.tlsOpts.caCerts,
			});

			if (!this.feats.PROT) {
				console.warn(
					"Server does not advertise TLS streams yet it was requested.\nAttempting anyways...",
				);
			}
			//switch data channels to TLS
			status = await this.command(Commands.Protection, "P");
			this.assertStatus(StatusCodes.OK, status, this.conn);
		}

		// 4. Attempt login
		status = await this.command(Commands.User, this.opts.user);
		if (status.code != StatusCodes.LoggedIn) {
			this.assertStatus(StatusCodes.NeedPass, status, this.conn);

			status = await this.command(Commands.Password, this.opts.pass);
			this.assertStatus(StatusCodes.LoggedIn, status, this.conn);
		}

		// 5. Switch to binary mode
		status = await this.command(Commands.Type, Types.Binary);
		this.assertStatus(StatusCodes.OK, status, this.conn);
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
		this.assertStatus(StatusCodes.DirCreated, res);
		const r = Regexes.path.exec(res.message);
		if (r === null) {
			throw { error: "Could not parse server response", ...res };
		}
		return r[1];
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
		this.assertStatus(StatusCodes.ActionOK, res);
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
		this.assertStatus(StatusCodes.ActionOK, res);
	}

	/**
	 * Download a file from the server.
	 * @param fileName
	 */
	public async download(fileName: string) {

		const readable = await this.downloadReadable(fileName);
		const data = await toArrayBuffer(readable);

		await this.finalizeStream();

		return new Uint8Array(data);
	}

	/**
	 * Download a file from the server using a ReadableStream interface.
	 * **Please call FTPClient.finalizeStream** to release the lock
	 * after the file is downloaded. Or, you can use the AsyncDispoable
	 * interface.
	 */
	public async downloadReadable(fileName: string): Promise<ReadableStream<Uint8Array> & AsyncDisposable> {
		await this.lock.lock();
		if (this.conn === undefined) {
			this.lock.unlock();
			throw FTPClient.notInit();
		}
		await this.initializeDataConnection();

		const res = await this.command(Commands.Retrieve, fileName);

		// #9 Seems there might be two possible codes, but since data
		// connection is already initialized, StartingTransfer (125)
		// seems more appropriate.
		if (res.code != StatusCodes.StartTransferConnection && res.code != StatusCodes.StartingTransfer) {
			this.assertStatus(
				StatusCodes.StartingTransfer,
				res,
				this.dataConn,
				this.activeListener,
			);
		}

		const conn = await this.finalizeDataConnection();

		return Object.assign(conn.readable, {
			[Symbol.asyncDispose]: async () => {
				await this.finalizeStream();
			}
		});
	}

	/**
	 * Download a file from the server with streaming.
	 * **Please call FTPClient.finalizeStream()** to release the lock after the file is done downloading.
	 * @deprecated Use downloadReadable instead.
	 * @param fileName
	 */
	public async downloadStream(fileName: string): Promise<Deno.Reader> {
		await this.downloadReadable(fileName);

		if (!this.dataConn) {
			throw new Error("Could not get download stream!");
		}

		return this.dataConn;
	}

	/**
	 * Upload a file to the server.
	 * @param fileName
	 * @param data
	 */
	public async upload(fileName: string, data: Uint8Array) {
		const writable = await this.uploadWritable(fileName, data.byteLength);
		const writer = writable.getWriter();

		await writer.write(data);

		await this.finalizeStream();
	}

	/**
	 * Upload a file using a WritableStream interface.
	 * **Please call FTPClient.finalizeStream()** to release the lock after
	 * the file is uploaded. Or, you can use the AsyncDispoable
	 * interface.
	 * @param fileName
	 * @param allocate Number of bytes to allocate to the file. Some servers require this parameter.
	 */
	public async uploadWritable(fileName: string, allocate?: number): Promise<WritableStream<Uint8Array> & AsyncDisposable> {
		await this.lock.lock();
		if (this.conn === undefined) {
			this.lock.unlock();
			throw FTPClient.notInit();
		}

		await this.initializeDataConnection();

		if (allocate !== undefined) {
			const res = await this.command(
				Commands.Allocate,
				allocate.toString(),
			);
			if (res.code !== 202 && res.code !== 200) {
				this.assertStatus(
					StatusCodes.OK,
					res,
					this.activeListener,
					this.dataConn,
				);
			}
		}

		const res = await this.command(Commands.Store, fileName);

		if (res.code != StatusCodes.StartTransferConnection && res.code != StatusCodes.StartingTransfer) {
			this.assertStatus(
				StatusCodes.StartTransferConnection,
				res,
				this.dataConn,
				this.activeListener,
			);
		}

		const conn = await this.finalizeDataConnection();

		return Object.assign(conn.writable, {
			[Symbol.asyncDispose]: async () => {
				await this.finalizeStream();
			}
		});
	}

	/**
	 * Upload a file to the server, with streaming.
	 * **Please call FTPClient.finalizeStream()** to release the lock after the file is done downloading.**
	 * @param fileName
	 * @param allocate Number of bytes to allocate to the file. Some servers require this parameter.
	 * @deprecated Use uploadWritable instead.
	 */
	public async uploadStream(fileName: string, allocate?: number): Promise<Deno.Writer> {
		await this.uploadWritable(fileName, allocate);

		if (!this.dataConn) {
			throw new Error("Failed to get upload channel!");
		}

		return this.dataConn;
	}

	/**
	 * Unlock and close connections for streaming.
	 */
	public async finalizeStream() {
		free(this.dataConn);
		this.dataConn = undefined;

		const res = await this.getStatus();
		this.assertStatus(StatusCodes.DataClose, res);

		this.lock.unlock();
	}

	/**
	 * Obtain file information from the FTP server.
	 * @param filename
	 */
	public async stat(filename: string): Promise<FTPFileInfo> {
		const retn: FTPFileInfo = {
			charset: null,
			ftpType: null,
			ftpperms: null,
			lang: null,
			mediaType: null,
			atime: null,
			birthtime: null,
			blksize: null,
			blocks: null,
			dev: NaN,
			gid: null,
			ino: null,
			mode: null,
			nlink: null,
			rdev: null,
			uid: null,

			isBlockDevice: null,
			isFifo: null,
			isSocket: null,
			isCharDevice: null,

			mtime: null,
			ctime: null,
			isSymlink: false,
			isFile: true,
			isDirectory: false,
			size: 0,
		};

		if (this.feats.MLST) {
			const status = await this.command(Commands.ExData, filename);
			this.assertStatus(StatusCodes.ActionOK, status);

			const entry = status.message.split("\r\n")[1];
			return this.parseMLST(entry)[1];
		} else {
			try {
				retn.size = await this.size(filename);
			} catch (e) {
				if (e.code !== StatusCodes.FileUnknown) {
					throw e;
				} else {
					retn.isDirectory = true;
					retn.isFile = false;
				}
			}

			if (retn.isFile) {
				retn.mtime = await this.modified(filename);
			}
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

		const res = await this.command(Commands.Size, filename);
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

		if (!this.feats.MDTM) {
			throw new Error("Feature is missing.", {
				cause: "Feature MDTM is not implemented by the FTP server.",
			});
		}

		const res = await this.command(Commands.ModifiedTime, filename);
		this.assertStatus(StatusCodes.FileStat, res);
		this.lock.unlock();

		return this.parseMDTM(res.message);
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
			throw FTPClient.notInit();
		}

		const res = await this.command(Commands.Delete, fileName);
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
			throw FTPClient.notInit();
		}

		const res = await this.command(Commands.RMDIR, dirName);
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
			throw FTPClient.notInit();
		}

		const res = await this.command(Commands.MKDIR, dirName);
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
			throw FTPClient.notInit();
		}

		const listing = await this.commandWithData(Commands.PlainList, dirName);
		return listing.trimEnd().split("\r\n");
	}

	public async extendedList(dirName?: string) {
		await this.lock.lock();
		if (this.conn === undefined) {
			this.lock.unlock();
			throw FTPClient.notInit();
		}

		const listing = await this.commandWithData(Commands.ExList, dirName);
		const entries = listing.split("\r\n");

		// Discard last entry, as it is usually "" from last newline
		if (entries[entries.length - 1].length === 0) {
			entries.pop();
		}

		return entries.map((e) => this.parseMLST(e));
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

	// Return name, stat
	private parseMLST(input: string): [string, FTPFileInfo] {
		const retn: FTPFileInfo = {
			charset: null,
			ftpType: null,
			ftpperms: null,
			lang: null,
			mediaType: null,
			atime: null,
			birthtime: null,
			blksize: null,
			blocks: null,
			dev: NaN,
			gid: null,
			ino: null,
			mode: null,
			nlink: null,
			rdev: null,
			uid: null,

			isCharDevice: null,
			isFifo: null,
			isSocket: null,
			isBlockDevice: null,

			mtime: null,
			ctime: null,
			isSymlink: false,
			isFile: true,
			isDirectory: false,
			size: 0,
		};
		const data = input.split(";");
		let filename = data.pop();
		if (filename) {
			// Remove initial space
			filename = filename.substring(1);
		} else {
			filename = "";
		}

		// No, I will not rewrite this.
		const fileStat = Object.fromEntries(
			// Lowercase the key.
			// Some implementations use lowercase or Uppercase keys.
			data.map((v) => v.split("=")).map(
				(a) => [a[0].toLowerCase(), a[1]],
			),
		);

		if (fileStat.type) {
			if (fileStat.type == "file") {
				retn.isFile = true;
				retn.isDirectory = false;
			} else if (
				fileStat.type == "dir" || fileStat.type == "cdir" ||
				fileStat.type == "pdir"
			) {
				retn.isDirectory = true;
				retn.isFile = false;
			}
		}
		if (fileStat.modify) {
			retn.mtime = this.parseMDTM(fileStat.modify);
		}
		if (fileStat.create) {
			retn.ctime = this.parseMDTM(fileStat.create);
		}
		if (fileStat.perm) {
			// TODO: parse https://www.rfc-editor.org/rfc/rfc3659#section-7.1
			retn.ftpperms = fileStat.perm;
		}
		if (fileStat.lang) {
			retn.lang = fileStat.lang;
		}
		if (fileStat.size) {
			retn.size = parseInt(fileStat.size);
		}
		if (fileStat["media-type"]) {
			retn.mediaType = fileStat["media-type"];
		}
		if (fileStat.charset) {
			retn.charset = fileStat.charset;
		}
		if (fileStat["unix.mode"]) {
			retn.mode = parseInt(fileStat["unix.mode"]);
		}
		if (fileStat["unix.uid"]) {
			retn.uid = parseInt(fileStat["unix.uid"]);
		}
		if (fileStat["unix.gid"]) {
			retn.gid = parseInt(fileStat["unix.gid"]);
		}
		if (fileStat.type) {
			retn.ftpType = fileStat.type;
		}
		return [filename, retn];
	}

	private parseMDTM(date: string): Date {
		const parsed = Regexes.mdtmReply.exec(date);
		if (parsed && parsed.groups) {
			const year = parseInt(parsed.groups.year);
			// Annoyingly, months are zero indexed
			const month = parseInt(parsed.groups.month) - 1;
			const day = parseInt(parsed.groups.day);
			const hour = parseInt(parsed.groups.hour);
			const minute = parseInt(parsed.groups.minute);
			const second = parseInt(parsed.groups.second);
			const ms = parsed.groups.ms;
			const date = new Date(year, month, day, hour, minute, second);
			if (ms !== undefined) {
				const n = parseFloat(ms);
				date.setMilliseconds(n * 1000);
			}
			return date;
		} else {
			throw new Error("Date is not in expected format.");
		}
	}

	// execute an FTP command
	private async command(c: Commands, args?: string) {
		if (!this.conn) {
			throw new Error("Connection not initialized!");
		}
		const encoded = this.encode.encode(
			`${c.toString()}${args ? " " + args : ""}\r\n`,
		);

		const writer = this.conn.writable.getWriter();
		await writer.write(encoded);

		writer.releaseLock();

		return await this.getStatus();
	}

	private async commandWithData(c: Commands, args?: string) {
		await this.initializeDataConnection();
		let res = await this.command(c, args);

		if (res.code != StatusCodes.StartTransferConnection && res.code != StatusCodes.StartingTransfer) {
			this.assertStatus(
				StatusCodes.StartTransferConnection,
				res,
				this.dataConn,
				this.activeListener,
			);
		}

		const conn = await this.finalizeDataConnection();
		const text = await toText(conn.readable);

		free(conn);

		res = await this.getStatus();
		this.assertStatus(StatusCodes.DataClose, res);

		this.lock.unlock();

		return text;
	}

	//parse response from FTP control channel
	private async getStatus(): Promise<FTPReply> {
		if (!this.conn) throw FTPClient.notInit();
		
		if (!this.connLineReader) {
			this.connLineReader = this.conn.readable
				.pipeThrough(new TextDecoderStream())
				.pipeThrough(new TextLineStream());
		}

		const lines: string[] = [];
		for await (const line of this.connLineReader.values({ preventCancel: true })) {
			lines.push(line);
			if (lines.length > 1) {
				// Status Code + SPACE signifies end.
				if (line.startsWith(lines[0].substring(0,3) + " ")) {
					break;
				}
			}
			// Not a multi-line message. Continue.
			else if (lines[0][3] !== "-") break;
		}

		const statusCode = parseInt(lines[0].substring(0, 3));

		if (lines.length > 1) {
			const lastLine = lines[lines.length - 1];
			lines[lines.length - 1] = lastLine.slice(4);
		}

		const message = lines.join("\r\n").slice(4);

		return {
			code: statusCode,
			message: message,
		};
	}

	private async epasvStart(res: FTPReply) {
		const parsed = Regexes.extendedPort.exec(res.message);
		if (parsed === null || parsed.groups === undefined) throw res;
		this.dataConn = await Deno.connect({
			port: parseInt(parsed.groups.port),
			hostname: this.host,
			transport: "tcp",
		});
	}

	private async pasvStart(res: FTPReply) {
		const parsed = Regexes.port.exec(res.message);
		if (parsed === null) throw res;
		this.dataConn = await Deno.connect({
			port: (parseInt(parsed[5]) << 8) + parseInt(parsed[6]),
			hostname: `${parsed[1]}.${parsed[2]}.${parsed[3]}.${parsed[4]}`,
			transport: "tcp",
		});
	}

	// initialize data connections to server
	private async initializeDataConnection() {
		if (this.opts.mode === "passive") {
			if (this.feats.EPSV) {
				const res = await this.command(Commands.ExtendedPassive);
				this.assertStatus(StatusCodes.ExtendedPassive, res);
				await this.epasvStart(res);
			} else {
				const res = await this.command(Commands.PassiveConn);

				// Some evil fucker decided PASV should return EPSV.
				// Sometimes.
				if (res.code === StatusCodes.ExtendedPassive) {
					await this.epasvStart(res);
				} else if (res.code === StatusCodes.Passive) {
					await this.pasvStart(res);
				} else {
					this.assertStatus(StatusCodes.Passive, res);
				}
			}
		} else {
			const listener = Deno.listen(
				{
					transport: "tcp",
					hostname: this.opts.activeIp,
					port: this.opts.activePort,
				},
			);
			this.activeListener = listener;

			if (this.feats.EPRT) {
				const res = await this.command(
					Commands.ExtendedPort,
					`|${
						this.opts.activeIpv6
							? "2"
							: "1"
					}|${this.opts.activeIp}|${this.opts.activePort}|`,
				);
				this.assertStatus(StatusCodes.OK, res, listener);
			} else {
				if (this.opts.activeIpv6) {
					throw new Error(
						"Active mode requested with IPv6 but server does not support EPRT",
					);
				}

				const res = await this.command(
					Commands.Port,
					`${this.opts.activeIp.replaceAll(".", ",")},${
						this.opts.activePort >> 8
					},${this.opts.activePort & 0x00FF}`,
				);
				this.assertStatus(StatusCodes.OK, res, listener);
			}
		}
	}

	// finalize connection for active and initiate TLS handshake if needed.
	private async finalizeDataConnection() {
		if (this.opts.mode == "active") {
			this.dataConn = await this.activeListener?.accept();
			free(this.activeListener);
		}
		if (this.dataConn === undefined) {
			throw new Error("Could not initialize data connection!");
		}
		if (this.opts.tlsOpts) {
			this.dataConn = await Deno.startTls(this.dataConn, {
				caCerts: this.opts.tlsOpts.caCerts,
				hostname: this.opts.tlsOpts.hostname,
			});
		}
		return this.dataConn;
	}

	// check status or throw error
	private assertStatus(
		expected: StatusCodes,
		result: FTPReply,
		...resources: (Disposable | undefined)[]
	) {
		if (result.code !== expected) {
			const errors: Error[] = [];
			resources.forEach((v) => {
				if (v !== undefined) {
					try {
						free(v);
					} catch (e) {
						errors.push(e);
					}
				}
			});
			this.lock.unlock();
			throw { ...result, errors };
		}
	}
}
