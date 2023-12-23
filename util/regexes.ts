const extendedPort =
	/\(([\x21-\x7E])(?<addrFamily>[0-9]*)\1(?<host>[0-9a-fA-F:.]*)\1(?<port>[0-9]*)\1\)/;
const port = /([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9]+),([0-9]+)/;
const path = /"(.+)"/;
const mdtmReply =
	/(?<year>[0-9]{4})(?<month>[0-9]{2})(?<day>[0-9]{2})(?<hour>[0-9]{2})(?<minute>[0-9]{2})(?<second>[0-9]{2})(?<ms>\.[0-9]+)?/;
export { extendedPort, mdtmReply, path, port };
