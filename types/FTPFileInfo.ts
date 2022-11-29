export type FTPFileInfo = Deno.FileInfo & {
    ctime: Date | null,
    ftpperms: string | null,
    lang: string | null,
    mediaType: string | null,
    charset: string | null,
    ftpType: string | null,
}
