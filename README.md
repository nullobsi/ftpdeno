# FTPDeno

Pure TypeScript FTP Client for Deno. It is currently possible to do basic FTP tasks like uploading/downloading and
listing directories.

## TODO:

- Active connections have some issues for me.
- Download and upload do not support streaming, and thus store everything in memory.
- FTP over TLS support (currently everything is plaintext.)