export default function free(resource: Disposable | undefined) {
	if (resource) {
		try {
			resource[Symbol.dispose]();
		} catch (e) {
			if (e instanceof Deno.errors.BadResource) {
				return;
			}
			throw e;
		}
	}
}
