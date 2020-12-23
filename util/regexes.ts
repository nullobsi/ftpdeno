const passivePort = /\([\x21-\x7E][\x21-\x7E][\x21-\x7E](?<port>[0-9]+)[\x21-\x7E]\)/
const path = /"(.+)"/

export {
    passivePort,
    path,
}