# Fnb Master — Phân tích lượt đọc/ghi Firestore và phương án tối ưu

Ngày phân tích: 20/10/2026. Mã nguồn: `remix-fnb-master---pos (1).zip`.

## Kết luận

Nguyên nhân rõ nhất trong mã nguồn là ứng dụng đồng bộ gần như toàn bộ dữ liệu của quán ngay sau đăng nhập. Mỗi phiên mở 15 listener, bao gồm nhiều bảng lịch sử tăng dần theo thời gian, không giới hạn ngày, số lượng hay vai trò. Cùng lúc đó, thanh toán tạo nhiều bản ghi kho và làm thay đổi các document mà mọi thiết bị đang theo dõi. Firestore chưa được bật persistent cache.

Ba chủ quán không tương đương ba lượt đọc hay ba kết nối. Chi phí phụ thuộc số document trả về, số lần tải lại, số thiết bị/tab và những document thay đổi được phân phối tới các client.

Đây là kết luận từ phân tích tĩnh mã nguồn và đối chiếu tài liệu Firebase; chưa phải phân bổ chi phí thực đo. File ZIP không có số lượng document thực tế, biểu đồ Usage, log truy vấn production, Firestore Rules hoặc cấu hình index đã triển khai. Vì vậy chưa thể kết luận chính xác collection nào chiếm bao nhiêu phần trăm của 50.000 reads. Không chạy ứng dụng vào database thật trong quá trình phân tích.

## 1. Phạm vi đã kiểm tra

- Luồng React chính trong `src/App.tsx`, cấu hình Firebase, đăng nhập/đăng ký, gọi món, bếp, gộp/chuyển bàn, thanh toán, quản lý ca, kho, khách hàng, chấm công, lương và báo cáo.
- Những component gọi trực tiếp Firestore và các component nhận dữ liệu qua props rồi lọc/tính toán phía client.
- Hai đường webhook `server.ts` và `api/sepay-webhook.ts`; chức năng xuất dữ liệu, dọn dẹp và xóa quán trong Super Admin.
- Kiểm tra đối chiếu các asset đã build: bundle iOS có các truy vấn lịch sử không giới hạn tương tự source. Bundle Android đính kèm khác bundle iOS/source; cần xác định bản đang thực sự được khách dùng, không mặc định tất cả thiết bị đã chạy cùng một bản.

Các vị trí bên dưới tính theo file gốc trong ZIP, chưa chỉnh sửa.

## 2. Bản đồ 15 listener khởi tạo khi đăng nhập

Tất cả nằm trong một `useEffect` ở `src/App.tsx:2473`. Điều kiện chỉ là có `currentUser`. Các truy vấn collection chỉ lọc `storeId`; không có `limit`, bộ lọc thời gian hoặc phân quyền tải dữ liệu theo màn hình.

| Dữ liệu | Vị trí trong App.tsx | Phạm vi thực sự tải | Cách dùng phù hợp hơn |
|---|---:|---|---|
| stores | 2480 | Một document cửa hàng | Có thể giữ live cho trạng thái cửa hàng/gói |
| users | 2520 | Mọi nhân viên của quán | Hồ sơ hiện tại; danh sách tối thiểu khi cần; quản trị tải riêng |
| menu | 2527 | Thực đơn lẫn hàng hóa/nguyên liệu | Tách thông tin thực đơn khỏi tồn kho thay đổi thường xuyên |
| tables | 2534 | Mọi bàn và mảng orders của mỗi bàn | Giữ live cho thiết bị vận hành; ưu tiên dữ liệu đang phục vụ |
| shifts | 2555 | Toàn bộ ca mở và ca cũ | Ca mở live; lịch sử theo kỳ; ca lỗi chưa xử lý tải riêng |
| invoices | 2568 | Toàn bộ hóa đơn từ trước đến nay | Lịch sử theo ngày/kỳ + cursor; tổng hợp ngày cho dashboard |
| inventory_logs | 2575 | Toàn bộ nhật ký nhập/xuất | Chỉ tải khi xem kho, theo kỳ và phân trang |
| inventory_audits | 2592 | Toàn bộ phiếu kiểm kho | Tải khi xem kiểm kho, theo kỳ và phân trang |
| stock_card | 2609 | Toàn bộ thẻ kho | Lọc nguyên liệu + kỳ + phân trang; bỏ listener toàn quán |
| customers | 2626 | Mọi khách hàng | Tìm theo điện thoại/tên chuẩn hóa, giới hạn kết quả |
| table_groups | 2633 | Mọi nhóm bàn | Dữ liệu nhỏ, ít thay đổi; cache hoặc live có chọn lọc |
| cash_transactions | 2640 | Toàn bộ thu chi | Kỳ đang xem + số dư/tổng hợp được lưu riêng |
| settings | 2647 | Mọi settings có cùng storeId; chỉ dùng doc đầu | Một document có ID xác định theo quán |
| attendance_records | 2656 | Chấm công mọi nhân viên, mọi ngày | Hôm nay của bản thân; tháng của người/phòng quản lý cần xem |
| payroll_records | 2662 | Toàn bộ bảng lương | Theo userId và month hoặc tháng quản trị đang xem |

Máy bếp, nhân viên order, thu ngân, chủ quán đều đi qua khối này. Màn hình chỉ chấm công `?checkin=true` cũng đi qua khối đăng ký listener trước khi trả về giao diện chấm công (`App.tsx:3889`). Tính năng bị khóa theo gói ở giao diện không ngăn khối đồng bộ tải dữ liệu (`App.tsx:4044` trở đi).

## 3. Các nguyên nhân theo mức độ ưu tiên

### P0 — Tải toàn lịch sử rồi mới lọc/phân trang

Ví dụ truy vấn thực tế:

```ts
const invoicesQuery = query(
  collection(db, 'invoices'),
  where('storeId', '==', storeId)
);
const unsubInvoices = onSnapshot(invoicesQuery, snapshot => {
  setInvoices(snapshot.docs.map(d => ({ ...d.data(), id: d.id })));
});
```

Nếu quán có 3.000 hóa đơn, một lần tải kết quả đầy đủ là khoảng 3.000 document reads chỉ cho hóa đơn. Xem giao diện chỉ hiện 10 hóa đơn không thay đổi con số đã tải.

Bằng chứng lọc phía client:

- `ReportsView`, `App.tsx:1972`: dùng `invoices.filter(...)` chọn hôm nay.
- `SummaryView.tsx:109`, `130`, `140`: lọc hóa đơn, nhật ký kho và thu chi theo kỳ sau khi tải.
- `SummaryView.tsx:398`: phân trang bằng `data.slice(...)`.
- `TaxReportView.tsx:27`: cộng doanh thu quý/nửa năm/năm từ mảng invoices đã tải.
- `ShiftView.tsx:81`: chỉ hiển thị ca 3 ngày gần nhất nhưng truy vấn gốc đã tải tất cả ca.
- `InventoryView.tsx:342`: lọc mặt hàng và ngày từ mảng stockCard đã tải.
- `MyPayrollView.tsx:26`, `31`; `UserMgmtView.tsx:129`: chọn nhân viên/tháng sau khi tải lương và chấm công của cả quán.

Đây là lỗi thiết kế truy vấn trực tiếp, không phải giả thuyết do mạng.

### P0 — stock_card tăng nhanh hơn số hóa đơn

`handleCheckout`, `App.tsx:3526–3613`, tạo thẻ kho cho từng hàng hóa bán trực tiếp, từng nguyên liệu trong định lượng món và từng món kèm liên kết kho. Cùng một nguyên liệu xuất hiện ở nhiều món có thể có nhiều lần ghi trong một hóa đơn.

Ví dụ giả định: 100 hóa đơn/ngày × 6 dòng xuất kho/hóa đơn × 30 ngày = **18.000 document thẻ kho/quán**. Ba quán ở quy mô đó chỉ cần tải đầy đủ stock_card một lần trên một máy mỗi quán đã khoảng **54.000 reads**, chưa tính hóa đơn và các bảng khác.

Code có xóa thẻ kho quá 100 ngày, nhưng việc xóa diễn ra sau khi đã tải về. Nó không tránh chi phí đọc ban đầu, và 100 ngày vẫn có thể là tập dữ liệu rất lớn. Nếu quán không bật theo dõi kho hoặc chưa cấu hình recipe, nguyên nhân này sẽ nhẹ hơn; cần xác nhận số document thực tế.

### P0/P1 — Đọc dữ liệu không cần thiết trên tất cả thiết bị

Một máy bếp hiện vẫn nhận lịch sử hóa đơn, thu chi, khách hàng, lương, chấm công và biến động nguyên liệu. Việc chủ quán chỉ có một tài khoản không ngăn tài khoản đó mở nhiều máy/tab. Nhân viên cũng có thể tạo thêm các client độc lập.

Mỗi thay đổi được phát tới các listener liên quan trên các client khác có thể phát sinh reads. Cần tính theo thiết bị/phiên, không theo số user chủ quán. Không mặc định hai callback giống nhau trong cùng một SDK luôn tương đương hai subscription backend độc lập.

### P1 — Chưa có persistent cache cho Firestore

`src/lib/firebase.ts:20` chỉ cấu hình `experimentalForceLongPolling: true` và `ignoreUndefinedProperties: true`. Không cấu hình `persistentLocalCache` hoặc bật persistence của Firestore.

`indexedDBLocalPersistence` ở dưới là cấu hình Firebase Auth, không phải cache dữ liệu Firestore. Ứng dụng Capacitor này dùng Firebase JavaScript SDK trong WebView; không được suy ra rằng có cache mặc định giống native Firestore SDK chỉ vì chạy trên iPhone/Android.

Theo tài liệu Firebase, khi không bật persistence, kết nối listener lại được tính như truy vấn mới; khi đã bật, mốc mất kết nối hơn 30 phút vẫn có thể khiến tính như truy vấn mới. Cache giúp giảm một phần tải lại, không biến đồng bộ dữ liệu thành miễn phí. [S1, S2]

### P1 — Thanh toán ghi nhiều nơi, rồi tất cả máy nhận cập nhật

Các thao tác trong batch checkout:

| Thao tác | Vị trí App.tsx | Số write thông thường |
|---|---:|---:|
| Tạo hóa đơn | 3438 | 1 |
| Cập nhật bàn | 3509 | 1 |
| Tạo thu tiền | 3513 | 1 |
| Cập nhật ca đang mở | 3617 | 1 nếu có ca |
| Cập nhật điểm khách hàng | 3444 | 1 nếu có khách |
| Cập nhật tồn kho | 3537, 3563, 3595 | Một lần mỗi nhánh khấu trừ được thực thi |
| Tạo thẻ kho | 3551, 3577, 3609 | Một lần mỗi nhánh khấu trừ được thực thi |

Nếu có ca, không có khách gắn bill, không ghi thêm log hủy, và có 6 lần khấu trừ kho: **4 + 2 × 6 = 16 write operations/hóa đơn**. Batch gom request và bảo đảm commit nguyên khối; không biến 16 writes thành 1 write được tính phí. [S1, S5]

Nếu 6 nguyên liệu là 6 document khác nhau, số document liên quan đổi theo ví dụ trên cũng là 16. Các máy đang nghe rộng nhận nhiều cập nhật không cần thiết. Đây là hiệu ứng tăng cả writes và reads; không có nghĩa mỗi thay đổi luôn làm server gửi lại toàn bộ collection.

Collection `menu` chứa cả danh mục ít thay đổi và `stock` thường xuyên thay đổi. Vì thế mọi máy nghe menu đều bị ảnh hưởng khi trừ kho. Chỉ đổi sang `updateDoc({stock: ...})` chưa giải quyết vấn đề phân phối, vì Firestore listener đọc theo document, không tính theo số field cần dùng.

### P2 — Xóa/sửa dữ liệu trong callback đọc

`App.tsx:2579`, `2596`, `2613`: mỗi client tự quét dữ liệu nhận được rồi xóa lịch sử quá hạn; `2538`: tự xóa note còn sót trên bàn trống.

Nhiều thiết bị có thể cùng cố dọn một dữ liệu. Trong lúc các thao tác async chưa hoàn tất, snapshot tiếp theo cũng có thể gặp lại các bản ghi còn trong kết quả. Đây là nguồn thao tác dư và khó quản lý vòng đời dữ liệu. Không khẳng định có vòng lặp vô hạn.

Việc xóa document thật khỏi kết quả listener không tự phát sinh document-read charge cho thông báo xóa đó theo bảng giá; các chi phí ở đây là đọc trước khi xóa, các thao tác delete thực hiện và công việc client dư. [S1]

### P2 — Các đường đọc phụ

- `App.tsx:3764`, `3792`, `3810`: mỗi lần lưu settings lại query để tìm ID document.
- `App.tsx:3703`: query tìm payroll trước khi cập nhật/tạo; phù hợp dùng ID theo quán–nhân viên–tháng.
- `App.tsx:3840`: check-in lấy các bản ghi trong ngày để tìm lượt gần nhất; cần lọc thêm storeId, sắp xếp và chỉ lấy lượt cần thiết, vẫn giữ khả năng nhiều lần vào/ra trong ngày.
- `LoginView.tsx:42`: đọc `users limit(1)` chỉ để thử kết nối; ít reads nhưng không cần dùng dữ liệu nhân viên làm health check.
- `App.tsx:2141` và `SubscriptionAlert.tsx:67`: packages được tải ở nhiều nơi. Modal gia hạn còn nghe store trong khi root đã nghe; nên tái sử dụng state, không mặc định listener này nhân đôi phí vì SDK có thể dùng chung target.
- `SuperAdminView.tsx:449` xuất toàn hệ thống bằng getDocs của 16 collection. `482` dọn rác cũng quét toàn collection. Đây có thể tạo đột biến rất lớn khi bấm nút, nhưng không chạy liên tục trong phiên POS thông thường.
- `server.ts:55`, `api/sepay-webhook.ts:57`: đọc processed_transactions cho mỗi giao dịch vào trước khi xác định nội dung có phải gia hạn hay không. Sau đó có fallback đọc toàn stores và toàn packages. Với 3 quán đây thường là nguồn phụ, trừ khi webhook có lưu lượng/retry cao.
- Các cấu hình source và server có cùng project fallback. Nếu môi trường thử nghiệm không override, thử app cũng dùng quota cùng project production. Cần kiểm tra môi trường thực chạy, không suy đoán từ source rằng chắc chắn đang xảy ra.

## 4. Vì sao 3 chủ quán đã đủ hết 50K?

Ví dụ hoàn toàn minh họa, không phải dữ liệu lấy từ database:

| Giả định | Giá trị |
|---|---:|
| Số quán | 3 |
| Thiết bị/quán | 1 |
| Hóa đơn lịch sử/quán | 3.000 |
| Dòng thu tiền tương ứng/quán | 3.000 |
| Số lần truy vấn đầy đủ/quán/ngày | 3 |
| Reads riêng hai bảng | **3 × 1 × 3 × (3.000 + 3.000) = 54.000** |

Chưa tính kho, thực đơn, khách hàng, ca, lương, thay đổi realtime, rules và các truy vấn phụ. Như vậy không cần nhiều người dùng để giải thích hiện tượng.

Mô hình gần đúng cần dùng khi đo:

**Reads/ngày = tổng document của các lần tải đầy đủ + các thay đổi backend được phân phối tới listener + getDoc/getDocs riêng + reads do Rules/index khi có.**

Truy vấn rỗng có mức tính tối thiểu; quota miễn phí áp dụng chung cho database đủ điều kiện trong project, không cấp riêng cho mỗi user hoặc mỗi store. Quota reset theo giờ Pacific, không theo 0h Việt Nam. [S1]

Không lấy số lần callback `onSnapshot` chạy hoặc cộng `snapshot.size` ở mọi callback làm hóa đơn reads. Một snapshot có 10.000 docs trong bộ nhớ nhưng một lần thay đổi chỉ liên quan 1 doc không đồng nghĩa bị tính thêm 10.000 reads. Cache, local write và metadata event cũng phải được phân biệt.

## 5. Phương án đề xuất triển khai

### Bước 1 — Cắt tải thừa, giữ mô hình dữ liệu hiện tại trước

Tách khối Firebase Sync thành các hook theo nhu cầu. Dependency ổn định theo storeId, userId, role, màn hình, kỳ truy vấn và quyền gói. Giữ một subscription dùng chung cho dữ liệu vận hành cần dùng xuyên màn hình; không gắn/tháo listener lớn liên tục chỉ vì đổi tab nhỏ.

| Thiết bị/màn hình | Dữ liệu cần sống |
|---|---|
| Bếp | Đơn/bàn đang xử lý, cấu hình bếp cần thiết |
| Order | Bàn/đơn đang phục vụ, thực đơn, tình trạng bán, ca bản thân |
| Thu ngân | Dữ liệu phục vụ thanh toán, ca hiện tại; lịch sử hóa đơn chỉ khi mở |
| Chủ quán | Tổng hợp ngày, ca mở, cảnh báo chưa xử lý; chi tiết tải khi xem |
| Chấm công | User hiện tại, cấu hình chấm công, lượt chấm công hiện hành |
| Kho | Tồn hiện tại khi cần; thẻ kho theo mặt hàng/kỳ |
| Lương | Theo tháng; nhân viên chỉ tải dữ liệu bản thân |

Giới hạn lịch sử tại Firestore, không dùng `.filter()` sau khi tải. Hóa đơn và sổ quỹ phân trang 30–50 document. Lịch sử cũ dùng getDocs theo yêu cầu; chỉ dùng realtime cho phạm vi đang thực sự cần theo dõi. Tránh tải lại trang đã có nếu chưa cần refresh; cache trang phải có thời hạn hoặc cơ chế làm mới khi dữ liệu lịch sử có thể sửa/hủy.

Với bếp và order, không đặt limit tùy tiện làm rơi đơn đang phục vụ. Có thể giữ listener toàn bộ tables nếu quán chỉ vài chục bàn: đây là tập nhỏ và hữu ích hơn nhiều so với lịch sử hàng chục nghìn bản ghi.

### Bước 2 — Phân trang thật và tách tổng khỏi danh sách

Mẫu dưới đây là đề xuất, chưa áp dụng vào source. Field `date` hiện là ISO UTC string, vì vậy truyền cùng kiểu string cho query; không chuyển một phía thành Timestamp mà bỏ quên dữ liệu cũ.

```ts
import {
  collection, query, where, orderBy, limit,
  startAfter, getDocs,
  type QueryDocumentSnapshot, type DocumentData,
} from 'firebase/firestore';

async function loadInvoicePage(
  storeId: string,
  startIso: string,
  endIsoExclusive: string,
  cursor?: QueryDocumentSnapshot<DocumentData>,
) {
  const constraints = [
    where('storeId', '==', storeId),
    where('date', '>=', startIso),
    where('date', '<', endIsoExclusive),
    orderBy('date', 'desc'),
  ];
  const q = query(
    collection(db, 'invoices'),
    ...constraints,
    ...(cursor ? [startAfter(cursor)] : []),
    limit(50),
  );
  const snap = await getDocs(q);
  return {
    items: snap.docs.map(d => ({ ...d.data(), id: d.id })),
    nextCursor: snap.docs.at(-1),
    mayHaveMore: snap.size === 50,
  };
}
```

Mỗi bộ lọc mới phải reset cursor; có thể lưu stack cursor/trang để quay lại. Dùng DocumentSnapshot làm cursor hỗ trợ các bản ghi trùng date. Nếu cần trang dữ liệu bất biến trong lúc có nhiều hóa đơn mới, cố định mốc truy vấn và xử lý cập nhật trang đầu riêng. `limit(50)` giới hạn document danh sách, không giới hạn doanh thu của ngày. [S3]

Ngày kinh doanh phải tính theo Asia/Ho_Chi_Minh: từ 00h giờ Việt Nam đến 00h ngày tiếp theo, đổi ra UTC trước khi query. Ca qua nửa đêm cần quy ước ngày kinh doanh rõ ràng. Không dùng `toISOString().slice(0,10)` như ngày địa phương.

Tạo composite index cho các tổ hợp thực dùng như storeId + date, storeId + itemId + date, storeId + staffId + status, storeId + userId + month. Có thể phát sinh index khác tùy màn hình và cách sort. Index làm query chạy được/hiệu quả; tự thêm index không giảm số document ứng dụng cố tình tải về.

### Bước 3 — Tổng hợp ngày/ca cho báo cáo chủ quán

Thêm dữ liệu tổng hợp, ví dụ `stores/{storeId}/daily_stats/{businessDate}`, chứa số hóa đơn, tổng bán, tiền mặt, chuyển khoản và giá vốn cần thiết. Biểu đồ có thể dùng các bucket giờ; bán chạy dùng bản tổng hợp mặt hàng theo ngày, có giới hạn kích thước.

Dashboard ngày nghe một số ít document tổng hợp, còn hóa đơn chi tiết chỉ tải khi người dùng xem. Báo cáo tháng đọc các tổng hợp ngày, báo cáo dài kỳ có thể dùng tổng hợp tháng khi đã thấy cần thiết. Đây là đánh đổi thêm writes lúc giao dịch để giảm nhiều lần đọc lịch sử.

Phương án nhẹ hơn: dùng aggregation `sum`/`count` khi mở báo cáo lịch sử. Phương án này vẫn tính phí đọc index, không phải miễn phí, và không hỗ trợ realtime/offline như document listener. Không gọi tổng hợp toàn năm mỗi vài giây. [S4, S6]

Tính đúng trước khi tối ưu:

- Không tính tổng doanh thu từ 50 hóa đơn trên trang hiện tại.
- `SummaryView.tsx:178` đang tính số dư đầu kỳ từ mọi thu chi trước đó. Khi thu hẹp query phải có checkpoint số dư hoặc cơ chế tổng hợp số dư đầu kỳ, cùng quy trình cập nhật lại nếu có điều chỉnh quá khứ.
- Các khoản chi tháng/lương tháng dùng trong báo cáo ngày vẫn phải được cung cấp từ tổng hợp tháng hoặc query riêng; chỉ lấy thu chi hôm nay sẽ làm lợi nhuận sai.
- Báo cáo quý/năm trong TaxReportView phải đọc tổng hợp đầy đủ kỳ, không đọc mảng invoice đã bị cắt trang.
- Cảnh báo chênh lệch cũ chưa xử lý phải có query riêng; không được biến mất chỉ vì ca đã quá 3 ngày. Có thể bổ sung `needsReview: true` và backfill các ca cũ.
- Giữ nguồn hóa đơn, sổ quỹ và dấu vết đối soát đủ độc lập để phát hiện sửa/hủy; không cùng ép mọi tổng về một giá trị rồi vô tình che mất chênh lệch.
- Mọi sửa, hủy, hoàn tiền, đổi phương thức và giao dịch ghi lùi ngày phải cập nhật phần chênh lệch cho đúng kỳ. Nên dùng bút toán đảo/void có audit thay vì xóa dấu vết.
- Tổng hợp phải do đường ghi đáng tin cậy thực hiện; quyền client và Rules cần tương ứng. Nếu dùng Cloud Functions, tính cả chi phí thực thi và yêu cầu billing; xử lý sự kiện trùng và thứ tự sự kiện, không cộng increment mù mỗi lần trigger được gọi lại.

Không cần chuyển toàn bộ database sang cấu trúc subcollection ngay. Với các collection đang có, thêm điều kiện truy vấn, indexes và tổng hợp đã có thể đem lại phần lớn lợi ích.

### Bước 4 — Tách danh mục thực đơn khỏi tồn kho

Hiện `MenuItem` chứa cả giá, ảnh, recipe, add-ons và stock. Khuyến nghị tách:

- `menu`: thông tin bán hàng ít đổi.
- `inventory_balances`: số lượng tồn theo nguyên liệu/hàng hóa.
- `stock_card`: lịch sử biến động, chỉ đọc theo nhu cầu.
- Tình trạng bán hết hàng: trạng thái nhỏ được đồng bộ cho máy order khi cần.

Máy order không cần nghe số gram nguyên liệu giảm sau mỗi hóa đơn. Chủ quán có thể nghe cảnh báo tồn thấp thay vì mọi thay đổi của mọi nguyên liệu. Giá vốn/công thức chỉ gửi tới client cần xử lý, hoặc để backend thanh toán tra cứu có kiểm soát.

Trước khi ghi kho, cộng gộp toàn bộ mức khấu trừ theo `ingredientId` của hóa đơn. Mỗi nguyên liệu chỉ cập nhật balance một lần. Thẻ kho có thể gộp thành một dòng cho mỗi nguyên liệu–hóa đơn, giữ chi tiết nguồn món trong dữ liệu để truy vết. Ví dụ 3 món cùng dùng một nguyên liệu có thể giảm từ 3 update + 3 thẻ kho xuống 1 update + 1 thẻ kho cho nguyên liệu đó.

Không gom tất cả đơn/thẻ kho vào một document khổng lồ để giảm reads. Cách đó tạo tranh chấp ghi, giới hạn kích thước và buộc mọi người tải lại nội dung lớn.

### Bước 5 — Bật persistent cache có kiểm soát

Mẫu cấu hình phù hợp Firebase JS SDK hiện có trong package:

```ts
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';

export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  ignoreUndefinedProperties: true,
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});
```

Phải kiểm tra IndexedDB trên WebView iOS/Android và trình duyệt thực dùng; xử lý trường hợp persistence không khả dụng. Cache cần phân biệt `fromCache`, `hasPendingWrites` và trạng thái đã xác nhận từ server. Đăng xuất/đổi quán phải reset state và có chính sách dữ liệu lưu lại trên thiết bị dùng chung. Không dùng cache cũ làm căn cứ duy nhất cho thanh toán đa máy. [S2]

Không ưu tiên bỏ long polling chỉ để giảm read quota; đây là lựa chọn transport. Không thay listener nhỏ bằng `getDocs` lặp mỗi 5–10 giây, vì cách đó có thể đọc lại tập dữ liệu nhiều hơn.

### Bước 6 — Giảm thao tác phụ và dọn dẹp tập trung

- Dùng ID cố định cho settings theo storeId, payroll theo storeId/userId/month để cập nhật trực tiếp; migrate/dedupe doc cũ trước khi chuyển đường đọc. Không bỏ các lần đọc nghiệp vụ cần kiểm tra xung đột chỉ để tiết kiệm một read.
- Chấm công: dùng một record trạng thái hiện tại hoặc query lượt gần nhất của store/user/ngày. Không ép chỉ có một lượt/ngày nếu nghiệp vụ cho phép vào/ra nhiều ca.
- Packages/config ít đổi: dùng shared state/cache với cơ chế phiên bản hoặc thời hạn hợp lý.
- Dọn lịch sử bằng một job có kiểm soát nếu thật sự cần; query chỉ tập quá hạn, giới hạn batch. Không xóa lịch sử chỉ để giảm reads: ngừng tải nó mỗi phiên thường là bước cần làm trước. TTL là phương án riêng có tính phí, không phải free quota delete. [S1]
- Chuẩn hóa mã cửa hàng, bỏ fallback quét toàn stores trong webhook; nếu đã biết packageId thì lấy đúng package. Chặn request không thuộc nghiệp vụ trước khi đọc Firestore và bắt buộc xác thực webhook.
- Chức năng backup/admin dùng job/export có lịch và kiểm soát phạm vi, không thử lặp lại full-export chỉ để đo reads.
- Tách project test/emulator khỏi production và xác nhận đúng build đang chạy. Tắt debug log trong bản phát hành để giảm nhiễu; việc tắt log không tự giảm document reads.

## 6. Những điểm không nên sửa vội chỉ vì chi phí

1. **Không có bằng chứng listener bị tạo lại mỗi lần React render.** Khối đồng bộ có cleanup unsubscribe đủ 15 listener và dependency là `[currentUser?.storeId, currentUser?.id]` (`App.tsx:2667–2684`). Callback store cập nhật object currentUser không tự đổi hai khóa này.
2. **Bộ đếm thời gian 1 giây chỉ cập nhật giao diện.** Không thấy query Firestore trong timer của bàn/bếp.
3. **Không đổ lỗi production cho StrictMode.** Cần phân biệt hành vi kiểm tra effect ở dev với bản build production.
4. **Đổi `snapshot.docs.map` sang `docChanges` chủ yếu giảm xử lý/render.** Không tự thu hẹp kết quả query hoặc đổi số reads backend đã tính.
5. **Batch và Promise.all chủ yếu giảm round trip/thời gian.** Muốn giảm writes phải giảm thao tác thừa hoặc document cần ghi.
6. **Giảm kích thước document chủ yếu giúp băng thông/độ trễ.** Muốn giảm số reads phải giảm document đọc hoặc số lần nhận thay đổi. Dù vậy OrderItem hiện spread toàn MenuItem vào order (`App.tsx:716`) nên nên bỏ ảnh/trường kho không cần khỏi dòng hóa đơn, giữ snapshot giá/giá vốn cần cho lịch sử.
7. **Không dừng toàn bộ đồng bộ nền tùy tiện.** Cảnh báo hiện được tạo từ dữ liệu listener và LocalNotifications; muốn nhận cảnh báo khi ứng dụng không chạy cần thiết kế push từ backend, không chỉ tháo listener rồi kỳ vọng thông báo vẫn đến.

## 7. Tính đúng khi có nhiều máy

`App.tsx:3534`, `3560`, `3592`, `3618` tính stock và tổng ca từ state trên máy rồi ghi giá trị tuyệt đối. Hai máy thanh toán đồng thời có thể ghi đè kết quả của nhau; batch atomic không tự giải quyết việc đọc state cũ.

Nên dùng increment cho phép cộng/trừ độc lập, transaction khi cần kiểm tra điều kiện từ dữ liệu mới nhất, và khóa nghiệp vụ/idempotency theo lần thanh toán. Không dùng invoice ID ngẫu nhiên mới ở mỗi lần retry như một cơ chế chống bill trùng. Các đường sửa/hủy/hoàn phải cùng quy tắc.

Transaction có thể thêm reads và retry, nhưng đây là chi phí cần thiết cho tính đúng khi có điều kiện cạnh tranh. Không đánh đổi mất tiền/mất dữ liệu để giảm vài read. Việc tối ưu chính vẫn là ngừng tải lịch sử dư thừa. [S5]

Sau khi chuyển sang phân trang, `handleDeleteInvoice` hiện tìm cash transaction trong mảng đã tải (`App.tsx:3152`) sẽ không còn đáng tin. Dùng liên kết ID trực tiếp hoặc backend truy vấn đúng invoiceId; thao tác hủy phải xử lý đầy đủ bill, sổ quỹ, kho, điểm khách, ca và tổng hợp. Đường hiện tại chỉ hoàn kho trực tiếp loại goods, chưa hoàn theo recipe/add-on trong đoạn này.

## 8. Kiểm tra quyền truy cập liên quan đến kiểm soát chi phí

Mã đăng nhập hiện query username/password trên Firestore (`LoginView.tsx:108`); đăng ký lưu password thành field (`RegisterStoreView.tsx:83`); có nhánh superadmin cố định ở client (`LoginView.tsx:72`). Trong mã nguồn luồng này không thấy bước Firebase Auth sign-in thực tế trước khi đọc dữ liệu.

Đây là vấn đề cụ thể cần sửa khi phân quyền tải dữ liệu: dùng Firebase Auth hoặc phiên server đáng tin cậy, Rules theo tenant/role, và bảo vệ endpoint phía server. Ẩn menu ở React không phải biện pháp kiểm soát quyền truy cập dữ liệu. File ZIP không chứa Rules đang triển khai, nên chưa thể khẳng định database đang public, đã bị truy cập trái phép hoặc đó là nguyên nhân hết quota.

Rules dùng get/exists/getAfter có thể phát sinh reads phụ; cần đọc Rules thực tế để đánh giá. Không được loại bỏ kiểm tra tenant chỉ để tiết kiệm reads. [S1]

## 9. Kế hoạch đo để xác định tỷ trọng thật

1. Ghi build/version, projectId thực chạy, số thiết bị/tab, vai trò và giờ mở app cho từng quán.
2. Đo số document theo storeId ở các collection lớn. Có thể dùng count aggregation thay cho tải full collection; vẫn có chi phí và chỉ làm khi có quyền truy cập phù hợp. Không cần lấy toàn bộ nội dung hóa đơn để biết số lượng.
3. Bọc điểm đăng ký listener/getDocs để ghi nhãn query, thời điểm attach/detach, số doc ban đầu, số changes, `fromCache`, `hasPendingWrites`. Gom log local hoặc gửi telemetry theo lô; không tạo một document log Firestore cho mỗi read/callback.
4. Đối chiếu tổng Usage/billing theo khung giờ. Log callback chỉ là chỉ báo, không phải bộ đếm phí chính xác do local events, rules, index và dùng chung target.
5. Thử kịch bản có kiểm soát: mở mới, để yên, thanh toán một bill, chuyển màn hình, mất mạng/ngắn hạn, mở lại app. Dùng emulator/staging cho thử tải và tính đúng; production chỉ quan sát/đo phạm vi nhỏ cần thiết.
6. Sau sửa, xác nhận không còn query lịch sử vô hạn trên đường đăng nhập; máy bếp/order không tải lương/kho lịch sử; thay đổi ngày thực sự thay đổi query server; doanh thu/số dư/cảnh báo vẫn đúng.

Không chạy full export hoặc quét lại nhiều lần để chứng minh rằng full export đang tốn reads.

## 10. Thứ tự giao việc cho lập trình viên

| Thứ tự | Việc cần làm | Kết quả kiểm chứng |
|---|---|---|
| 1 | Tách listener theo vai trò/màn hình; bỏ các lịch sử khỏi bootstrap | Mở máy bếp/order không tải hóa đơn, sổ quỹ, thẻ kho, payroll cũ |
| 2 | Query theo ngày/kỳ + cursor pagination; bổ sung nguồn tổng hợp/số dư đúng | Trang đầu hữu hạn; báo cáo không cộng thiếu do limit |
| 3 | Persistent cache và quản lý vòng đời listener | Đo được hành vi cache/reconnect trên đúng thiết bị |
| 4 | Tổng hợp ngày/ca; dữ liệu cảnh báo riêng khi cần | Chủ quán xem nhanh mà không tải toàn hóa đơn |
| 5 | Tách menu/tồn kho; gộp trừ kho theo nguyên liệu; chống thanh toán trùng | Giảm writes và cập nhật gửi tới máy không cần; nhiều máy không ghi đè |
| 6 | Dọn lịch sử tập trung, ID xác định, tối ưu admin/webhook | Không còn thao tác đọc/xóa dư và quét toàn hệ thống ngoài ý muốn |

Không cam kết một tỷ lệ giảm tổng reads/ngày khi chưa đo dữ liệu thật. Riêng ví dụ tải hai bảng 6.000 docs nếu chuyển thành hai trang đầu 50 docs thì phần tải danh sách đó giảm còn khoảng 100 docs, tức khoảng 98,3%. Tổng chi phí thực còn phụ thuộc tổng hợp, listeners vận hành, tải trang tiếp, Rules và writes mới. Ưu tiên giữ Firestore và sửa cách truy cập hiện tại trước khi cân nhắc chuyển nền tảng database.

## Nguồn chính thức đã đối chiếu

- [S1 — Firebase: Understand Cloud Firestore billing](https://firebase.google.com/docs/firestore/pricing)
- [S2 — Firebase: Access data offline](https://firebase.google.com/docs/firestore/manage-data/enable-offline)
- [S3 — Firebase: Paginate data with query cursors](https://firebase.google.com/docs/firestore/query-data/query-cursors)
- [S4 — Firebase: Summarize data with aggregation queries](https://firebase.google.com/docs/firestore/query-data/aggregation-queries)
- [S5 — Firebase: Transactions and batched writes](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [S6 — Firebase: Write-time aggregations](https://firebase.google.com/docs/firestore/solutions/aggregation)

Các con số mô phỏng được ghi rõ giả định. Các nhận định về logic ứng dụng được dẫn tới vị trí source trong file ZIP. Báo cáo này đề xuất thiết kế và thứ tự sửa, chưa phải bản code đã áp dụng hay xác nhận sau triển khai.
