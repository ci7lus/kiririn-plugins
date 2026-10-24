import NiconiComments, {
	type FormattedComment,
} from "@xpadev-net/niconicomments";

/** Owns a canvas for one renderer generation; destroyed WebGL contexts cannot be reused. */
export class CommentRenderer {
	private canvas: HTMLCanvasElement;
	private readonly renderer: NiconiComments;
	private destroyed = false;

	constructor(
		container: HTMLElement,
		comments: FormattedComment[],
		format: "empty" | "formatted",
	) {
		this.canvas = container.ownerDocument.createElement("canvas");
		this.canvas.width = 1920;
		this.canvas.height = 1080;
		this.canvas.style.width = "100%";
		this.canvas.style.height = "100%";
		this.canvas.style.display = "block";
		container.append(this.canvas);
		try {
			this.renderer = new NiconiComments(this.canvas, comments, {
				format,
				lazy: true,
			});
			this.adoptRendererCanvas(container);
		} catch (error) {
			this.adoptRendererCanvas(container);
			this.releaseCanvas();
			throw error;
		}
	}

	addComments(...comments: FormattedComment[]) {
		this.renderer.addComments(...comments);
	}

	drawCanvas(vpos: number) {
		this.renderer.drawCanvas(vpos);
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		try {
			// clear() only erases pixels; destroy() releases listeners, timers and GL resources.
			this.renderer.destroy();
		} finally {
			this.releaseCanvas();
		}
	}

	private adoptRendererCanvas(container: HTMLElement) {
		// niconicomments may replace the canvas when falling back from WebGL to 2D.
		const canvas = container.querySelector("canvas");
		if (canvas && canvas !== this.canvas) {
			this.canvas.width = 0;
			this.canvas.height = 0;
			this.canvas = canvas;
		}
	}

	private releaseCanvas() {
		this.canvas.remove();
		this.canvas.width = 0;
		this.canvas.height = 0;
	}
}
