// Requires --allow-net and --allow-write
import {FTPClient} from "https://deno.land/x/ftpc/mod.ts";

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
