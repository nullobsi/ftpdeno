// structure that implements a basic queue sequence through promises
export default class Lock {
	private inUse = false;

	private queue: Array<() => void> = [];

	constructor() {
	}

	public lock(): Promise<void> {
		if (this.inUse) {
			return new Promise<void>((res) => {
				this.queue.push(() => {
					this.inUse = true;
					res();
				});
			});
		} else {
			this.inUse = true;
			return new Promise<void>((res) => res());
		}
	}

	public unlock() {
		this.inUse = false;
		this.queue.shift()?.call(this);
	}
}
