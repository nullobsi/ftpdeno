const extendedPort = /[\x21-\x7E](?<addrFamily>[0-9]*)[\x21-\x7E](?<host>.*)[\x21-\x7E](?<port>[0-9]*)[\x21-\x7E]/;
const port = /([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9]+)/;
const path = /"(.+)"/;
const mdtmReply = /(?<year>[0-9]{4})(?<month>[0-9]{2})(?<day>[0-9]{2})(?<hour>[0-9]{2})(?<minute>[0-9]{2})(?<second>[0-9]{2})(?<ms>\.[0-9]+)?/;
export {
    extendedPort,
    port,
    path,
    mdtmReply,
}
