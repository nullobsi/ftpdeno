# FTPDeno

Pure TypeScript FTP Client for Deno. It is currently possible to do basic FTP tasks like uploading/downloading and
listing directories. TLS is supported, however due to [issues in Deno](https://github.com/denoland/deno/issues/6427), servers that use older ciphers may have issues connecting. [SSL session reuse](https://github.com/denoland/deno/issues/8875) is also not supported. 

Unstable is required.

## TODO:

- Active connections have some issues for me.
- Download and upload do not support streaming, and thus store everything in memory.