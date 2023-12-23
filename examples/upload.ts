import { FTPClient } from "../mod.ts";

// Create a connection to an FTP server
const client = new FTPClient("ftp.server", {
	// Enable TLS
	tlsOpts: {
		implicit: false,
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
const randomData = new Uint8Array(4096);
crypto.getRandomValues(randomData);

// CD into the folder "files" on the server
await client.chdir("files");

// Create a stream to upload the file random.bin with a size of 4096 bytes
const uploadStream = await client.uploadWritable("random.bin", 4096);
uploadStream.getWriter().write(randomData);

// Close the stream and notify the server that file upload is complete
await client.finalizeStream();

// Redownload the file from the server
const downloadedData = new Uint8Array(await client.download("random.bin"));

// Compare the files
for (let i = 0; i < randomData.length; i++) {
	const n1 = randomData[i];
	const n2 = downloadedData[i];
	if (n1 !== n2) {
		console.log(`Files are not the same at ${i}!`);
	}
}
