enum Commands {
    User = "USER",
    Password = "PASS",
    CdUp = "CDUP",
    CWD = "CWD",
    Quit = "QUIT",
    ActiveConn = "EPRT",
    PassiveConn = "EPSV",
    Type = "TYPE",

    Retrieve = "RETR",
    Store = "STOR",
    Allocate = "ALLO",

    RenameFrom = "RNFR",
    RenameTo = "RNTO",
    Delete = "DELE",
    RMDIR = "RMD",
    MKDIR = "MKD",
    PWD = "PWD",
    List = "NLST",

    Auth = "AUTH",
}

enum Types {
    ASCII = "A",
    EBCDIC = "E",
    Binary = "I",
}

export {Types, Commands}