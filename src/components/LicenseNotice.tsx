import { useEffect, useState } from "react";

const LICENSE_FILE_NAME = "LICENSES.md";

type LicenseState =
	| { status: "loading" }
	| { status: "loaded"; text: string }
	| { status: "error"; message: string };

export default function LicenseNotice() {
	const [state, setState] = useState<LicenseState>({ status: "loading" });

	useEffect(() => {
		const controller = new AbortController();

		fetch(LICENSE_FILE_NAME, { signal: controller.signal })
			.then((response) => {
				if (!response.ok) {
					throw new Error(`${response.status} ${response.statusText}`);
				}

				return response.text();
			})
			.then((text) => {
				setState({ status: "loaded", text });
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) {
					return;
				}

				const message = error instanceof Error ? error.message : String(error);
				setState({ status: "error", message });
			});

		return () => controller.abort();
	}, []);

	return (
		<details className="rounded-lg border border-gray-700 bg-[#252525] p-4 text-white shadow-lg">
			<summary className="cursor-pointer font-bold text-indigo-400">
				使用ライブラリのライセンス
			</summary>
			<div className="mt-3">
				<p className="mb-3 text-xs leading-relaxed text-gray-400">
					ビルド時に収集した依存ライブラリのライセンスです。 ファイル名:{" "}
					{LICENSE_FILE_NAME}
				</p>

				{state.status === "loading" && (
					<p className="text-sm text-gray-400" role="status">
						ライセンス情報を読み込んでいます…
					</p>
				)}

				{state.status === "error" && (
					<p className="text-sm leading-relaxed text-red-300" role="alert">
						ライセンス情報を読み込めませんでした（{state.message}）。
					</p>
				)}

				{state.status === "loaded" && (
					<pre className="max-h-128 overflow-auto whitespace-pre-wrap break-words rounded border border-gray-700 bg-[#1f1f1f] p-3 font-mono text-[11px] leading-relaxed text-gray-200">
						{state.text}
					</pre>
				)}
			</div>
		</details>
	);
}
