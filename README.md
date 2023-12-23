# FTPDeno

Pure TypeScript FTP Client for Deno. [Docs here](https://doc.deno.land/https/deno.land/x/ftpc/mod.ts)

Tested using vsFTPd v3.0.3. 
However, tests are not extensive; please report problems if they occur! 

Supports:
* Active and passive mode
* Implicit and explicit TLS
* Downloading/uploading via Readable and Writable interfaces
* List files
* Deleting/creating directories and files
* Renaming files/directories

## Usage
This is also located in the Examples folder.

```ts
// Requires --allow-net and --allow-write
import { FTPClient } from "https://deno.land/x/ftpc/mod.ts";

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

// Since we did `using`, connection is automatically closed.
console.log("Finished!");

```

