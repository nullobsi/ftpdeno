export interface ConnectionOptions {
    user?: string,
    pass?: string,
    port?: number,
    mode?: "active" | "passive",
    activePort?: number,
    activeIp?: string,
    activeIpv6?: boolean,
}

export interface IntConnOpts {
    user: string,
    pass: string,
    port: number,
    mode: "active" | "passive",
    activePort: number,
    activeIp: string,
    activeIpv6: boolean,
}