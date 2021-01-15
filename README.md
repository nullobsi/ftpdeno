# FTPDeno

Pure TypeScript FTP Client for Deno. [Docs here](https://doc.deno.land/https/deno.land/x/ftpc/mod.ts)

TLS is supported, however due to [issues in Deno](https://github.com/denoland/deno/issues/6427), servers that use older ciphers may have issues connecting. 
[SSL session reuse](https://github.com/denoland/deno/issues/8875) is coming to Deno soon! Tested using vsFTPd v3.0.3. 
However, tests are not extensive; please report problems if they occur! 

Unstable is required.

Supports:
* Active and passive mode
* Implicit and explicit TLS
* Downloading/uploading via streams or ArrayBuffer
* List files
* Deleting/creating directories and files
* Renaming files/directories

## Usage
This is also located in the Examples folder.

```ts
// Requires --allow-net and --allow-write
import FTPClient from "https://deno.land/x/ftpc/mod.ts";

// Connect as anonymous user
let client = new FTPClient("speedtest.tele2.net");
await client.connect();
console.log("Connected!");

// Download test file
console.log("Downloading...");
let file = await Deno.open("./5MB.zip", {
    create: true,
    write: true,
});
let stream = await client.downloadStream("5MB.zip");
await Deno.copy(stream, file);

// Close download stream
await client.finalizeStream();
file.close();
console.log("Finished!")

// Log off server
await client.close();
```