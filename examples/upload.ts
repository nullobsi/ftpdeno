import {FTPClient} from "../mod.ts";

// Create a connection to an FTP server
let client = new FTPClient("ftp.server", {
    // Enable TLS
    tlsOpts: {
        implicit: false
    },

    // Authentication information
    // Default is anonymous for username and password
    user: "anonymous",
    pass: "tester",

    // Default is passive mode and port 21
    mode: "passive",
    port: 21,
});

// Initialize connection
await client.connect();

// Generate random data
let randomData = new Uint8Array(4096);
crypto.getRandomValues(randomData);

// CD into the folder "files" on the server
await client.chdir("files");

// Create a stream to upload the file random.bin with a size of 4096 bytes
let uploadStream = await client.uploadStream("random.bin", 4096);
await uploadStream.write(randomData);

// Close the stream and notify the server that file upload is complete
await client.finalizeStream();

// Redownload the file from the server
let downloadedData = await client.download("random.bin");

// Compare the files
for (let i = 0; i < randomData.length; i++) {
    let n1 = randomData[i];
    let n2 = downloadedData[i];
    if (n1 !== n2) {
        console.log(`Files are not the same at ${i}!`);
    }
}
