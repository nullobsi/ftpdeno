// Requires --allow-net and --allow-write
import { FTPClient } from "../mod.ts";

// Connect as anonymous user
using client = new FTPClient("speedtest.tele2.net");

await client.connect();
console.log("Connected!");

// Download test file
console.log("Downloading...");

{
	using file = await Deno.open("./5MB.zip", {
		create: true,
		write: true,
	});

	// Use Readable and Writable interface for fast and easy tranfers.
	await using stream = await client.downloadReadable("5MB.zip");
	await stream.pipeTo(file.writable);
} // Because of `await using`, finalizeStream is called and server is notified.

// File is already closed by pipeTo method.
console.log("Finished!");

// Since we did `using`, connection is automatically closed.

