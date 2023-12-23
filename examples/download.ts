// Requires --allow-net and --allow-write
import { FTPClient } from "../mod.ts";

// Connect as anonymous user
const client = new FTPClient("speedtest.tele2.net");
await client.connect();
console.log("Connected!");

// Download test file
console.log("Downloading...");
const file = await Deno.open("./5MB.zip", {
	create: true,
	write: true,
});
const stream = await client.downloadReadable("5MB.zip");
await stream.pipeTo(file.writable);

// Close download stream. File is already closed by pipeTo method.
await client.finalizeStream();
console.log("Finished!");

// Log off server
await client.close();
