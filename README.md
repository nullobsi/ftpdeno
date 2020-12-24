# FTPDeno

Pure TypeScript FTP Client for Deno. 

TLS is supported, however due to [issues in Deno](https://github.com/denoland/deno/issues/6427), servers that use older ciphers may have issues connecting. [SSL session reuse](https://github.com/denoland/deno/issues/8875) is also not supported. Tested using vsFTPd v3.0.3. However, tests are not extensive; please report problems if they occur! 

Unstable is required.

Supports:
* Active and passive mode
* Implicit and explicit TLS
* Downloading/uploading via streams or ArrayBuffer
* List files
* Deleting/creating directories and files
* Renaming files/directories