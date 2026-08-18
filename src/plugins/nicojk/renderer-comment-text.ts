const RESPONSE_ANCHOR_PATTERN = />>\d+(?:-\d+)?/u;

// 通常の URL と h 抜き URL（ttp:// / ttps://）を対象にする。
const URL_PATTERN =
	/h?ttps?:\/\/[A-Za-z0-9][A-Za-z0-9._~:/?@!$&'()*+,;=%-]*/giu;

/**
 * レンダラーへ渡すコメント本文を整形する。
 *
 * レスアンカーを含むコメントは会話の一部だけになりやすいため、
 * Panel の元データは残したまま、レンダラーでは既定で除外する。
 */
export function formatRendererCommentContent(content: string): string | null {
	if (RESPONSE_ANCHOR_PATTERN.test(content)) {
		return null;
	}

	const formatted = content
		.replace(URL_PATTERN, " ")
		.replace(/[ \t]{2,}/gu, " ")
		.trim();
	return formatted.length > 0 ? formatted : null;
}
