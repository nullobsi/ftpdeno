export interface ConnectionOptions {
    user?: string,
    pass?: string,
    port?: number,
    mode?: "active" | "passive",
    activePort?: number,
    activeIp?: string,
    activeIpv6?: boolean,
    tls?: boolean,
    tlsOpts?: {
        implicit??: boolean,
        hostname: string,

    },
}

export interface IntConnOpts {
    user: string,
    pass: string,
    port: number,
    mode: "active" | "passive",
    activePort: number,
    activeIp: string,
    activeIpv6: boolean,
    tlsOpts?: {
        implicit: boolean,
        hostname: string,

    },
}