export default function free(resource: Deno.Closer | undefined) {
	if (resource) {
		try {
			resource.close();
		} catch (e) {
			if (e instanceof Deno.errors.BadResource) {
				return;
			}
			throw e;
		}
	}
}
