/**
 * Che bớt dữ liệu định danh trước khi trả cho người KHÁC chủ sở hữu.
 *
 * Một responder cần đủ thông tin để xác nhận "đúng người này" - bốn số cuối CCCD làm được việc đó,
 * so khớp được với thẻ căn cước trong ví nạn nhân. Cả 12 số thì không thêm gì cho việc cứu người,
 * nhưng đủ để mở tài khoản ngân hàng, đăng ký SIM, hay tra cứu người đó ở nơi khác - và mọi lần quét
 * đều ghi lại được, kể cả quét vì tò mò.
 *
 * KHÔNG dùng cho đường đọc hồ sơ của chính mình: công dân phải thấy đầy đủ số của họ.
 */

/** Số ký tự cuối giữ nguyên. 4 là đủ để đối chiếu, không đủ để tái sử dụng ở nơi khác. */
const VISIBLE_TAIL = 4;

/**
 * `123456789885` -> `********9885`.
 *
 * Idempotent: che một chuỗi đã che vẫn ra đúng chuỗi đó, nên an toàn khi một giá trị đi qua nhiều
 * lớp (worker ghi vào DynamoDB đã che, read-server che thêm lần nữa lúc trả về).
 * Chuỗi ngắn hơn hoặc bằng 4 ký tự bị che TOÀN BỘ - để lộ cả một số 4 chữ số thì việc che thành vô
 * nghĩa. Giá trị rỗng/null trả về nguyên trạng: không có gì để che.
 */
export function maskCccd(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;

  const raw = String(value).trim();
  if (raw === "") return raw;

  if (raw.length <= VISIBLE_TAIL) return "*".repeat(raw.length);

  const tail = raw.slice(-VISIBLE_TAIL);
  return "*".repeat(raw.length - VISIBLE_TAIL) + tail;
}

/**
 * Trả về bản sao của một hồ sơ công dân với `cccdNumber` đã che. Không có trường đó thì trả nguyên
 * đối tượng, nên gọi được trên mọi payload responder nhìn thấy mà không cần biết hình dạng của nó.
 */
export function maskCitizenIdentifiers<T>(entity: T): T {
  if (!entity || typeof entity !== "object") return entity;

  const e = entity as Record<string, unknown>;
  if (!("cccdNumber" in e)) return entity;

  return { ...e, cccdNumber: maskCccd(e.cccdNumber as string | null | undefined) } as T;
}
