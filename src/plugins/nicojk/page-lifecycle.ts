type LifecycleTarget = Pick<Window, "addEventListener" | "removeEventListener">;

/** Mounts the page after initialization and releases page-owned state on pagehide. */
export function startPageLifecycle(
	target: LifecycleTarget,
	initialize: () => Promise<unknown>,
	mount: () => void,
	unmount: () => void,
	dispose: () => void,
) {
	let active = true;
	let generation = 0;

	const initializeAndMount = async () => {
		const currentGeneration = generation;
		try {
			await initialize();
		} catch (error) {
			console.error("Failed to initialize NicoJK page", error);
		}

		if (active && currentGeneration === generation) {
			mount();
		}
	};

	const handlePageHide = () => {
		if (!active) return;
		active = false;
		generation += 1;
		try {
			unmount();
		} finally {
			dispose();
		}
	};

	const handlePageShow = () => {
		if (active) return;
		active = true;
		generation += 1;
		void initializeAndMount();
	};

	target.addEventListener("pagehide", handlePageHide);
	target.addEventListener("pageshow", handlePageShow);
	void initializeAndMount();

	return () => {
		try {
			handlePageHide();
		} finally {
			target.removeEventListener("pagehide", handlePageHide);
			target.removeEventListener("pageshow", handlePageShow);
		}
	};
}
