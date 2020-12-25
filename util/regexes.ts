const passivePort = /\([\x21-\x7E][\x21-\x7E][\x21-\x7E](?<port>[0-9]+)[\x21-\x7E]\)/
const path = /"(.+)"/
const mdtmReply = /(?<year>[0-9]{4})(?<month>[0-9]{2})(?<day>[0-9]{2})(?<hour>[0-9]{2})(?<minute>[0-9]{2})(?<second>[0-9]{2})(?<ms>\.[0-9]+)?/;
export {
    passivePort,
    path,
    mdtmReply,
}