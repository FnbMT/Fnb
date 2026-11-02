# Fnb Master — Kiểm toán Firestore bản code sửa đổi

Ngày phân tích: 20/10/2026.

## 1. Kết luận

Bản mới đã giảm lượng dữ liệu tải thường trực, nhưng chưa giải quyết được hai nguồn chi phí lớn: báo cáo tải toàn bộ chứng từ của tháng/năm và mọi thiết bị nhận thay đổi tồn kho qua collection `menu`. Việc thêm `limit` ở nhiều nơi còn gây thiếu dữ liệu, có thể làm sai lương, sổ quỹ và lịch sử kho.

Chưa nên dùng bản này làm cơ sở mở rộng thương mại trước khi xử lý các lỗi về ca của nhân viên order, tính đúng báo cáo, thanh toán đồng thời và kiểm soát truy cập.

Kết luận này dựa trên mã nguồn, so sánh hai phiên bản và kiểm tra cô lập các đoạn code thực tế. Chưa có số liệu production, vùng đặt database, số thiết bị và biểu đồ Usage/Billing. Vì vậy, không thể quy chính xác bao nhiêu trong 50.000 reads thực tế cho từng nguyên nhân, cũng không thể kết luận chi phí trả phí sẽ làm mô hình kinh doanh không khả thi.

Không sửa mã ứng dụng, không triển khai và không thực hiện đọc/ghi Firestore production trong đợt kiểm tra này.

## 2. Những thay đổi đã đúng hướng

| Thay đổi | Đánh giá |
|---|---|
| `persistentLocalCache` và `persistentMultipleTabManager` | Giúp tái sử dụng dữ liệu trên cùng trình duyệt; không loại bỏ reads của thay đổi mới hay chia sẻ cache giữa các máy |
| Listener hóa đơn, sổ quỹ có mốc đầu ngày | Giảm tải lịch sử lúc đăng nhập; còn lỗi mốc ngày không tự dịch chuyển |
| Kho, nhân sự và một phần Tổng kết tải theo màn hình | Hướng tốt; cần thu hẹp tiếp theo tác vụ, kỳ và quyền |
| Tách vai trò kitchen/order | Giảm listener nền; việc bỏ ca cho order làm hỏng nghiệp vụ |
| Điểm danh hôm nay lọc theo cửa hàng và người dùng | Tốt hơn tải toàn bộ điểm danh; state dùng chung với màn hình nhân sự còn xung đột |
| Webhook gia hạn tìm quán bằng điều kiện và `limit(1)` | Tốt hơn quét mọi cửa hàng; phần transaction mới chưa đáng tin cậy |

Kiểm tra root effect thực tế: admin/cashier/order_cashier có 11 listener; kitchen/order có 6. Bản cũ có 15 listener root. Các con số này chưa gồm listener theo màn hình, modal và các `getDocs` độc lập. Giảm số listener không đồng nghĩa giảm chi phí cùng tỷ lệ: số document và tần suất thay đổi mới quyết định phần lớn chi phí.

Nguồn: [firebase.ts](sandbox:/workspace/scratch/9a5780e43587/source-v2/src/lib/firebase.ts), [App.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v2/src/App.tsx), đoạn bắt đầu dòng 2482.

## 3. Ưu tiên sửa

| Mức | Phát hiện | Hướng xử lý |
|---|---|---|
| P0 | Rules mở toàn bộ dữ liệu vận hành; API quản trị thiếu xác thực | Hoàn thiện Firebase Auth, kiểm tra tenant/role, bỏ token giả và fallback quyền |
| P0 | Order không nhận ca đang mở | Listener riêng cho ca đang mở của chính nhân viên |
| P0 | Tổng hợp tiền/lương từ tập dữ liệu bị cắt | Truy vấn đúng kỳ; dùng tổng hợp/checkpoint đầy đủ |
| P0 | Thanh toán ghi đè số dư từ state cũ; thiếu chống xử lý lặp | Backend xác thực, transaction thực, mã yêu cầu cố định |
| P0 | Lớp Admin adapter không giữ đúng transaction/reference | Dùng Admin SDK trực tiếp; lỗi cấu hình phải báo thất bại |
| P1 | Báo cáo tháng/năm tải mọi chứng từ | Tổng hợp theo ngày/tháng hoặc aggregation query; chi tiết phân trang |
| P1 | Tồn kho thay đổi kéo theo menu trên mọi máy | Tách danh mục và số dư kho; chỉ truyền trạng thái bán được khi cần |
| P1 | Listener hóa đơn/thu chi/khách hàng vẫn chạy nền | Đăng ký theo nghiệp vụ và quyền cụ thể |
| P1 | `limit` không có thứ tự và cursor | Lọc ở server, `orderBy`, `limit`, `startAfter` |
| P1 | Cache lịch sử ghi đè realtime, không loại bản ghi đã xóa | Cache theo khóa truy vấn; thay thế tập dữ liệu, invalidation/version |
| P2 | Superadmin quét toàn hệ thống, tác vụ dọn/xuất dữ liệu lớn | Phân trang quản trị, thống kê lưu sẵn, job có phạm vi |
| P2 | Lookup cấu hình, lương; ghi sửa dữ liệu trong callback | ID xác định; đưa sửa dữ liệu vào luồng ghi nghiệp vụ |

## 4. Báo cáo vẫn có thể làm hết 50K reads rất nhanh

### 4.1. Tổng kết tải cả ba collection cho mỗi kỳ

[SummaryView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v2/src/components/SummaryView.tsx), dòng 140–220:

- Chọn ngày quá khứ, tháng hoặc năm sẽ lần lượt chạy `getDocs` cho `invoices`, `cash_transactions`, `inventory_logs` trong kỳ.
- Không có giới hạn, cursor hay kiểm tra tab con thực sự cần dữ liệu nào.
- State lịch sử tích lũy bản ghi nhưng không lưu thông tin “kỳ này đã tải và còn hiệu lực”. Chọn lại kỳ vẫn truy vấn lại.
- Rời màn hình chính làm component unmount (`App.tsx`, dòng 4093), mất cache component.
- `isMounted` chỉ ngăn cập nhật state. Kiểm tra cô lập xác nhận rằng sau cleanup, luồng vẫn phát đủ ba query. Nó không hủy request đã gửi và cũng không chặn hai query tiếp theo.
- Phân trang bằng `slice` ở dòng 511–514 chỉ chia dữ liệu đã tải về; không giảm reads Firestore.

**Minh họa, không phải số đo production:** một quán có 100 hóa đơn/ngày, mỗi hóa đơn có một giao dịch thu, trong 30 ngày:

`3.000 hóa đơn + 3.000 giao dịch thu = 6.000 document / lần xem tháng`, chưa tính nhật ký kho.

Ba quán, mỗi quán mở hoặc chọn lại kỳ này bốn lần: `3 × 4 × 6.000 = 72.000 document reads` trong điều kiện truy vấn được thực hiện trên server.

### 4.2. Báo cáo thuế luôn tải hóa đơn cả năm

[TaxReportView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v2/src/components/TaxReportView.tsx), dòng 26–60:

- Mount màn hình hoặc đổi `selectedYear` sẽ đọc mọi hóa đơn trong năm đó.
- Hai trường `fromDate`/`toDate` của sổ doanh thu không quyết định phạm vi fetch. Người dùng chọn kỳ thuộc năm khác có thể không có đủ dữ liệu cho kỳ ấy.
- Cache không dùng chung với Tổng kết.

Ví dụ quán đã có đủ 365 ngày, 100 hóa đơn/ngày: **36.500 reads mỗi lần tải năm**. Hai lần tải độc lập có thể đạt 73.000 reads, chỉ với một quán.

### 4.3. Sửa theo hai lớp dữ liệu

**Lớp tổng hợp:** màn hình tổng doanh thu, thuế, số lượng đơn, phương thức thanh toán đọc các document tổng hợp theo ngày. Một năm cần tối đa 365/366 document ngày. Nếu bổ sung tổng hợp tháng phù hợp thì báo cáo chỉ cần 12 document tháng. Mức giảm 36.500 xuống 365 là khoảng 99% cho riêng lượt tải tổng hợp trong ví dụ, không phải cam kết giảm 99% toàn hệ thống.

**Lớp chi tiết:** danh sách hóa đơn/sổ quỹ chỉ tải trang đang xem. Mở một chứng từ mới lấy chi tiết. Xuất toàn bộ dữ liệu là thao tác riêng, có phạm vi và chi phí tương ứng.

Không thể chỉ thay mọi thứ bằng `limit(50)` rồi cộng tổng 50 dòng đầu. Tổng toàn kỳ và trang chi tiết phải được tính từ hai nguồn phù hợp.

**Lựa chọn triển khai:**

| Phương án | Phù hợp | Đánh đổi |
|---|---|---|
| `count`/`sum` ở thời điểm đọc | Báo cáo tổng ít mở, cần sửa nhanh | Phụ thuộc index; không trực tiếp giải quyết nhóm món trong mảng hóa đơn |
| Document tổng hợp ngày | Dashboard thường dùng; số liệu theo ngày/tháng/năm | Thêm ghi khi có nghiệp vụ; phải xử lý hoàn/hủy/điều chỉnh |
| Tháng đã chốt + ngày hiện tại | Lịch sử dài, nhiều lần xem | Cần cơ chế chốt và cập nhật lại khi có điều chỉnh quá khứ |

Firebase phân biệt aggregation lúc đọc và lúc ghi; aggregation lúc đọc không hỗ trợ realtime và cache như document thông thường. Xem [hướng dẫn aggregation](https://firebase.google.com/docs/firestore/solutions/aggregation).

Không tự động cập nhật cả ngày, tháng và năm trên mọi hóa đơn nếu chưa cần: với 100 quán × 100 hóa đơn/ngày, mỗi một ghi phụ/hóa đơn đã thêm 10.000 writes/ngày. Có thể bắt đầu bằng tổng hợp ngày, tạo tổng hợp tháng khi chốt hoặc khi nhu cầu đọc chứng minh lợi ích.

## 5. `limit` hiện tại đang bỏ sót dữ liệu nghiệp vụ

Các vị trí trong [App.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v2/src/App.tsx):

| Dữ liệu | Dòng | Hiện tại | Hệ quả |
|---|---:|---|---|
| Customers | 2685 | Theo quán, `limit(100)` | Không phải 100 khách mới nhất; tìm kiếm local không thấy khách ngoài tập này |
| Inventory audits | 2704 | Theo quán, `limit(50)` | Không bảo đảm lấy kiểm kho gần nhất |
| Stock card | 2711 | Theo quán, `limit(50)` | Lọc tiếp nguyên liệu/ngày trên máy có thể trả thiếu hoặc rỗng |
| Inventory logs | 2729 | Theo quán, `limit(50)` | Không đủ làm tổng nhập/xuất theo ngày nếu có nhiều bản ghi |
| Payroll | 2736, 2761 | Theo quán, `limit(50)` | Không bảo đảm chứa tháng/người cần xem |
| Attendance | 2754 | Theo quán, `limit(150)` | Tính lương từ một phần lịch sử của toàn cửa hàng |

Không có `orderBy(date, desc)` trong các query trên. Query mặc định theo document ID; sort sau khi tải không lấy lại được document đã bị cắt. Cơ chế này được mô tả trong [Order and limit data](https://firebase.google.com/docs/firestore/query-data/order-limit-data).

Ví dụ 10 nhân viên, mỗi người một bản ghi/ngày trong 30 ngày đã có 300 bản ghi. Tập 150 bản ghi của toàn quán không đủ để tính lương tháng của tất cả nhân viên. Với ID không biểu diễn thời gian, tập ấy cũng không nhất thiết là nửa tháng gần nhất.

**Sửa:**

- Chấm công cá nhân: `storeId + userId + date từ đầu tháng đến đầu tháng sau`.
- Lương đã chốt: document xác định theo `storeId/userId/month`, hoặc query đúng các trường đó.
- Thẻ kho: `storeId + itemId + khoảng ngày`, sắp xếp thời gian, cursor.
- Kiểm kho, hóa đơn, thu chi: lọc đúng kỳ ở server, sắp xếp và phân trang.
- Khách: trang danh sách + tìm kiếm có điều kiện ở server; khi đã chọn khách, thao tác bằng ID, không phụ thuộc khách nằm trong 100 dòng đầu.

Ví dụ định hướng cho lịch sử hóa đơn, áp dụng schema chuỗi ISO hiện tại:

```ts
const filters = [
  where('storeId', '==', storeId),
  where('date', '>=', startIso),
  where('date', '<', nextPeriodStartIso),
  orderBy('date', 'desc'),
];
const q = lastDocument
  ? query(collection(db, 'invoices'), ...filters, startAfter(lastDocument), limit(50))
  : query(collection(db, 'invoices'), ...filters, limit(50));
```

Đây là mẫu thiết kế, chưa phải bản vá đã tích hợp. Dùng document snapshot làm cursor; triển khai index tương ứng. Quy định rõ cách refresh khi dữ liệu đổi trong lúc chuyển trang. Nếu chuyển sang `Timestamp`, cần migration nhất quán trước khi đổi kiểu query.

## 6. Các lỗi chính xác dữ liệu phát sinh từ cách tải mới

### 6.1. Vai trò order không thể nhận ca đang mở

`App.tsx`: `activeShift` khởi tạo `null` ở dòng 2478. Effect trả về sớm cho order ở dòng 2595. Listener đặt `activeShift` nằm sau đó, dòng 2615–2638. Hàm mở ca dòng 3736 chỉ `addDoc`, không đặt `activeShift`. Chọn bàn dòng 4200 vẫn yêu cầu order phải có ca.

Kết quả trong một phiên đăng nhập mới của order: có thể ghi ca nhưng UI không nhận ca, tiếp tục chặn gọi món; thao tác mở ca lại có thể tạo thêm ca. Cần đăng ký ca đang mở của chính nhân viên trước khi tách các listener quản lý. Không cần tải lịch sử mọi ca.

### 6.2. Ca đang mở bị cắt bởi cửa sổ ba ngày

Query dòng 2615 chỉ lọc `startTime >= ba ngày trước`; comment “ca đang mở và ca ba ngày” không đúng với điều kiện thực tế. Ca mở lâu hơn ba ngày và ca cũ chưa xử lý chênh lệch sẽ mất khỏi tập dữ liệu.

Tách query ca đang mở, query ca cần xử lý, và lịch sử ca đã đóng phân trang. Thêm bảo đảm một nhân viên không mở trùng ca do hai máy cùng thao tác.

### 6.3. Mốc “hôm nay” không cập nhật qua nửa đêm

Effect root phụ thuộc storeId/id/role; ngày chỉ tính khi effect chạy. Mở ứng dụng ngày A và giữ đến ngày B, query vẫn có mốc đầu ngày A và không có cận trên. Sau nhiều ngày, dữ liệu tiếp tục tăng. Listener điểm danh vẫn gắn ngày A.

Tạo `businessDate` theo múi giờ quán, cập nhật khi đổi ngày và khi ứng dụng trở lại foreground. Chỉ tái tạo query phụ thuộc ngày; tránh làm mọi listener menu/bàn/users chạy lại vì thay ngày. Với nhà hàng hoạt động qua đêm, thống nhất quy tắc ngày kinh doanh trước khi triển khai.

### 6.4. Dữ liệu lịch sử ghi đè realtime và làm sống lại bản ghi đã xóa

`SummaryView.tsx`, dòng 118–137; `TaxReportView.tsx`, dòng 63–68: merge realtime trước, lịch sử sau bằng Map theo ID. Do đó bản cũ thắng bản mới. Khi bản ghi biến mất khỏi live state, bản lịch sử vẫn còn.

Kiểm tra cô lập đúng đoạn merge: hóa đơn live có tổng 200, bản lịch sử có tổng 100, kết quả hiện tại trả 100. Live không còn hóa đơn, lịch sử vẫn giữ hóa đơn thì kết quả vẫn có một dòng.

Đảo thứ tự merge chỉ sửa phần ghi đè, không giải quyết xóa. Cache phải có khóa kỳ, version/invalidation, và thay thế kết quả của kỳ khi refetch; tránh cộng dồn Map vĩnh viễn. Với chứng từ tài chính, cân nhắc hủy/điều chỉnh có dấu vết thay vì xóa mất lịch sử.

### 6.5. Số dư đầu kỳ phụ thuộc việc người dùng đã xem những ngày nào

`SummaryView.tsx`, dòng 291–297: cộng các giao dịch trước đầu kỳ trong `allCashTransactions`. Nhưng state này chỉ có hôm nay và một số kỳ người dùng từng mở.

Kiểm tra mẫu: có khoản thu tiền mặt 500.000đ hôm trước. Mở mới màn hình hôm nay, state không chứa hôm trước nên số dư đầu kỳ bằng 0. Sau khi tải hôm trước, cùng công thức trả 500.000đ. Số dư không được phụ thuộc lịch sử bấm màn hình.

Cần số dư đã chốt/checkpoint và tổng biến động trong phạm vi cần tính. Không khôi phục bằng cách tải toàn bộ lịch sử ở mỗi lần xem. Nếu cho phép sửa quá khứ, phải áp dụng điều chỉnh hoặc tái tính checkpoint liên quan.

### 6.6. Chi phí phân bổ ngày và lương có thể sai

`SummaryView.tsx`, dòng 394–399 dùng payroll bị giới hạn. Dòng 420 tính chi phí thuê trong tháng từ prop `cashTransactions`, hiện chỉ có hôm nay, thay vì dữ liệu đầy đủ của tháng. Tiền thuê trả ngày khác không được phân bổ đủ vào lợi nhuận ngày.

Tổng chi phí vận hành/lương của tháng cần một nguồn hoàn chỉnh theo tháng. Cũng cần kiểm tra không tính lương hai lần từ cả bảng lương và giao dịch chi lương, theo quy ước báo cáo kế toán của ứng dụng.

### 6.7. Xóa hóa đơn lịch sử không thực thi

`App.tsx`, dòng 3225–3232: handler tìm hóa đơn trong state root `invoices`, nay chỉ có hôm nay; không tìm thấy thì return. Trong khi `SummaryView` đã hiển thị hóa đơn cũ từ lịch sử và vẫn gọi handler này.

Thao tác phải làm việc theo ID trên backend, kiểm tra quyền và trạng thái chứng từ; không phụ thuộc document đã có trên màn hình chính. Liên kết hóa đơn–thu chi–kho bằng ID xác định để hoàn/hủy chính xác, cập nhật tổng hợp cùng nghiệp vụ.

### 6.8. Hai listener cùng ghi state điểm danh

Root effect merge điểm danh của mình hôm nay vào `attendanceRecords`; effect nhân sự thay thế toàn bộ state bằng tối đa 150 bản ghi. Thứ tự callback có thể làm mất phần vừa merge. Tách state điểm danh hiện tại, bảng chấm công tháng và bảng lương cá nhân; mỗi nguồn có khóa query riêng.

## 7. Reads tăng theo thiết bị vì danh mục và tồn kho đang nằm chung

`App.tsx`, dòng 2529: mọi vai trò nghe toàn bộ `menu` của quán. Checkout dòng 3614–3698 cập nhật `stock` ngay trong các document menu. Vì vậy máy bếp, máy order và máy quản lý cùng nhận cập nhật số dư nguyên liệu dù không cần số tồn chi tiết.

**Mô hình minh họa:** một quán có năm máy đang nghe menu, một máy thanh toán, bốn máy còn lại; 100 hóa đơn/ngày, mỗi hóa đơn đổi bốn nguyên liệu khác nhau. Riêng bốn máy còn lại có thể nhận `4 × 100 × 4 = 1.600` cập nhật document/ngày. Với 50 quán tương tự là 80.000 cập nhật, chưa tính tải đầu, bàn, hóa đơn, sổ quỹ và ca. Đây là mô hình ước tính cho listener đang kết nối, không phải phép đo billing.

**Tách dữ liệu đề xuất:**

- `menu_catalog`: tên, giá, nhóm, định mức, hình; ít thay đổi. Cache theo version và chỉ cập nhật khi danh mục đổi.
- `inventory_balances`: số dư nguyên liệu; chỉ màn hình kho, người có quyền hoặc backend nghiệp vụ đọc.
- `availability`: trạng thái có thể bán/hết món nếu POS cần; cập nhật khi trạng thái đổi, không phát mọi thay đổi số lượng.

Không gộp toàn bộ quán vào một document lớn để giảm reads: sẽ làm mọi thay đổi gửi lại dữ liệu rộng, tăng tranh chấp và khó quản lý kích thước. Nếu thực đơn rất nhỏ, có thể cân nhắc tài liệu cấu hình gọn cho phần ít đổi; đo kích thước và tần suất trước.

Việc tách kho phải giữ đúng kiểm tra hết hàng, công thức món và addon. Backend có thể phát sinh reads để kiểm tra tồn; phải cộng cả chi phí đó khi so sánh với số reads tiết kiệm ở các máy.

## 8. Các listener nền và tác vụ thừa còn giảm được

### 8.1. Đăng ký theo nghiệp vụ cụ thể

Root hiện vẫn nghe invoices, cash, customers và toàn bộ users cho cashier/manager/admin, kể cả chỉ đang xem bàn. Nên chuyển:

| Màn hình/tác vụ | Dữ liệu cần |
|---|---|
| Bàn/gọi món | Bàn/đơn đang hoạt động, danh mục, khả dụng, ca cá nhân |
| Bếp | Đơn cần chế biến, dữ liệu hiển thị món cần thiết |
| Thanh toán | Đơn cần thanh toán, ca hiện tại, khách đã chọn |
| Dashboard | Tổng hợp hôm nay; chi tiết chỉ khi mở |
| Lịch sử | Query một kỳ, một trang |
| Lương cá nhân | Người đang đăng nhập và tháng được chọn |
| Nhân sự | Danh sách nhân viên khi cần; chấm công/lương chỉ ở tab con tương ứng |

Đưa `view`, tab con, filter, permission vào hook phù hợp. Các effect on-demand hiện mới kiểm tra `view`; vẫn có thể chạy khi màn hình thực tế hiển thị khóa gói dịch vụ.

### 8.2. Tránh “sửa dữ liệu” trong callback của mọi máy

`App.tsx`, dòng 2541: snapshot bàn trống còn note thì client gọi `updateDoc` xóa note. Nhiều máy có thể cùng sửa một trạng thái bất thường. Xóa note ngay trong thao tác kết thúc/hủy/gộp bàn; dữ liệu cũ xử lý bằng migration có phạm vi.

Đây không nhất thiết là vòng lặp vô hạn: sau khi note bị xóa, điều kiện dừng. Vấn đề là ghi trùng do nhiều máy cùng tự sửa.

### 8.3. Cache cần ở tầng dữ liệu

Đề xuất khóa cache gồm `storeId`, người/quyền khi cần, loại dữ liệu, kỳ, bộ lọc, cursor. Dùng cache dùng chung ngoài component; gộp request đang chạy cho cùng khóa. Cache danh mục và kỳ đã chốt lâu hơn dữ liệu hiện tại, invalidation khi có sửa/hủy. Không dùng TTL dài cho số liệu tiền đang vận hành mà không có cơ chế refresh.

Firestore persistence không biến `getDocs` online thành thao tác luôn miễn phí. Listener còn nhận document thay đổi; persistence cũng không tránh tải lại như query mới sau một lần ngắt kết nối đủ lâu theo quy định billing. Xem [billing listener](https://firebase.google.com/docs/firestore/pricing#listening_to_query_results).

Không đếm `snapshot.size` ở mọi callback rồi coi đó là billable reads: snapshot chứa cả tập kết quả, không chỉ phần mới. Đo callback, thay đổi document và lần gắn listener riêng, sau đó đối chiếu Usage/Billing.

## 9. WriteBatch chưa làm giảm số writes; checkout còn ghi lặp

`App.tsx`, dòng 3503–3714:

- Một hóa đơn có ca thường ghi: hóa đơn, bảng bàn, sổ quỹ, ca.
- Mỗi nhánh trừ tồn hợp lệ ghi một lần balance trong menu và tạo một stock card.
- Có thể ghi thêm điểm khách hàng và nhật ký đặc biệt.

Đặt `L` là tổng số nhánh trừ tồn thực sự chạy, `C` là 0/1 lần cập nhật điểm khách. Trong tình huống có ca, không có nghiệp vụ phụ:

`W_checkout ≈ 4 + 2L + C`.

Ví dụ `L = 6`, không cập nhật khách: 16 writes/hóa đơn. 100 hóa đơn/ngày là 1.600 writes/quán/ngày, chưa tính gọi món, bếp, kiểm kho, chấm công. 13 quán cùng mức đó đã là 20.800 writes/ngày.

Code có `stockUpdates` nhưng vẫn `batch.update` bên trong từng vòng lặp, nên chưa gộp thao tác ghi. Kiểm tra đoạn code thật với hai món cùng dùng hai nguyên liệu: phát sinh bốn balance updates + bốn stock cards, dù chỉ có hai nguyên liệu khác nhau.

**Tối ưu:** cộng delta theo ingredient ID trước; sau đó mỗi nguyên liệu chỉ cập nhật một lần và tạo một dòng sổ kho tổng theo hóa đơn–nguyên liệu. Nếu cần dấu vết từng món, chứa chi tiết phân rã trong dòng sổ đó với giới hạn kích thước phù hợp. Khi ấy phần kho chuyển từ `2L` xuống `2U`, với `U` là số nguyên liệu khác nhau. Nếu L=U, không có tiết kiệm ở bước này.

Batch giúp commit chung và giảm trao đổi mạng, mỗi set/update vẫn là một write; xem [pricing](https://firebase.google.com/docs/firestore/pricing). Nếu bổ sung tổng hợp, idempotency record hay availability document, phải cộng các writes mới vào mô hình.

## 10. Thanh toán nhiều máy phải sửa trước khi mở rộng

Hiện tại tồn kho tính từ `menu.stock`, doanh thu ca tính từ `activeShift.totalRevenue + total`, điểm khách tính từ state đã tải. Hai máy có thể cùng dựa vào giá trị cũ rồi ghi đè kết quả của nhau. Batch nguyên tử không phát hiện xung đột do đọc state cũ ngoài transaction.

Thiết kế phù hợp:

1. Backend xác thực người dùng, quán, ca và quyền thanh toán.
2. Mỗi lần thanh toán có khóa yêu cầu cố định, được giữ nguyên khi retry. Hóa đơn/thanh toán không phát sinh ID mới trên mỗi lần retry.
3. Transaction thực kiểm tra order/session chưa thanh toán; đọc dữ liệu cần kiểm tra trước khi ghi.
4. Tính delta kho theo nguyên liệu, áp dụng cập nhật hợp lệ; ghi hóa đơn, liên kết sổ quỹ, trạng thái đơn, ca và tổng hợp cần thiết.
5. Trả lại kết quả đã có nếu yêu cầu đã được xử lý. Không in hóa đơn hoặc phát tác dụng bên ngoài bên trong callback transaction có thể retry.

`increment` giải quyết một số phép cộng/trừ độc lập, không tự ngăn thanh toán trùng hay bảo đảm điều kiện tồn không âm. Nếu stock card cần số dư chính xác sau giao dịch, phải thiết kế cùng transaction/ledger; không ghi remaining suy ra từ cache cũ.

Backend/transaction có thêm reads và chi phí chạy. Đây là chi phí để đảm bảo đúng dữ liệu; chỉ so sánh tổng chi phí sau khi tính cả phần giảm listener và ghi lặp. Xem [transactions và batch](https://firebase.google.com/docs/firestore/manage-data/transactions).

## 11. Rules và API hiện tại không ngăn truy cập vượt quyền

### 11.1. Rules

[firestore.rules](sandbox:/workspace/scratch/9a5780e43587/source-v2/firestore.rules) cho phép đọc/ghi vô điều kiện ở menu, tables, invoices, kho, khách, sổ quỹ, settings, attendance, payroll, shifts. Users cũng cho phép tạo/sửa không điều kiện; comment về chặn password không được biểu đạt thành điều kiện rule.

**Nếu bộ rules này đã triển khai**, truy cập không hợp lệ có thể đọc/ghi dữ liệu xuyên cửa hàng và tiêu thụ quota. Đây là khả năng do mã nguồn cho phép; chưa có bằng chứng đã xảy ra lạm dụng.

### 11.2. API và Auth

- [save-user.ts](sandbox:/workspace/scratch/9a5780e43587/source-v2/api/save-user.ts), [change-password.ts](sandbox:/workspace/scratch/9a5780e43587/source-v2/api/change-password.ts), [delete-user.ts](sandbox:/workspace/scratch/9a5780e43587/source-v2/api/delete-user.ts): chưa xác minh ID token và quyền của người gọi trước thao tác.
- [server.ts](sandbox:/workspace/scratch/9a5780e43587/source-v2/server.ts), dòng 21–31: route gọi trực tiếp handler, không có middleware xác thực bù vào.
- [reveal-password.ts](sandbox:/workspace/scratch/9a5780e43587/source-v2/api/reveal-password.ts): có nhánh chấp nhận giá trị/token đặc biệt thay cho xác thực Firebase hợp lệ.
- [LoginView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v2/src/components/LoginView.tsx), dòng 85–96: Firebase sign-in lỗi vẫn đi tiếp vào ứng dụng.
- State người dùng khôi phục từ local storage; logout chưa gọi Firebase `signOut`.

Admin SDK bỏ qua Security Rules, nên chỉ sửa rules sẽ không bảo vệ được API backend thiếu kiểm tra quyền. Xem [tài liệu điều kiện Security Rules](https://firebase.google.com/docs/firestore/security/rules-conditions).

**Thứ tự triển khai:** sửa Auth/API và kiểm thử trước, migration tài khoản/quyền, rồi áp dụng rules tenant/role và kiểm tra lại mọi luồng. Không đóng rules trước khi đăng nhập Firebase hoạt động thật, vì có thể làm các máy hiện tại mất quyền truy cập.

Lấy storeId/role từ danh tính đã kiểm chứng, kiểm tra dữ liệu cũ và dữ liệu sau sửa không đổi tenant trái phép; không tin storeId/role do client gửi. Dùng rate limit phù hợp cho đăng nhập, đăng ký và tác vụ tốn dữ liệu. App Check là lớp bổ sung, không thay thế quyền người dùng.

## 12. Lớp `_firebaseAdmin` mới có rủi ro chức năng và tính nguyên tử

[api/_firebaseAdmin.ts](sandbox:/workspace/scratch/9a5780e43587/source-v2/api/_firebaseAdmin.ts):

- Dòng 346–395: `collection().doc()` trả object bọc chỉ có id/path/get/set/update/delete, ngay cả khi đã có Admin SDK.
- Dòng 436: `batch()` lại trả batch thật của Admin SDK.
- Dòng 447: `runTransaction()` chuyển thẳng callback vào Admin SDK thật. API batch/transaction nhận DocumentReference thật, không phải object bọc. Cách kết hợp hiện tại không tuân thủ hợp đồng SDK và có nguy cơ làm đăng ký quán/webhook thất bại. Cần kiểm thử tích hợp với Admin SDK đúng phiên bản; chưa chạy được phần đó trong audit.
- Khi fallback, “transaction” chỉ gọi get/update/set riêng, không có commit nguyên tử hay retry xung đột. Callback webhook không await các write đó vì đang dùng theo hợp đồng transaction thật.
- Dòng 264–312: lỗi đọc bị đổi thành “không tồn tại”; lỗi ghi hai collection bí mật/chống giao dịch lặp bị nuốt. API có thể báo thành công trong khi dữ liệu cần thiết chưa được ghi.
- Dòng 478–507: lỗi ký token chuyển thành token giả; nhánh verify nhận dạng token giả như đã xác thực.

Thay lớp này bằng Admin SDK thật với credential hợp lệ. Khi thiếu cấu hình/quyền, từ chối thao tác và ghi log lỗi có cấu trúc. Không đổi lỗi quyền thành đọc/ghi Client SDK để tiếp tục nghiệp vụ tài chính.

[sepay-webhook.ts](sandbox:/workspace/scratch/9a5780e43587/source-v2/api/sepay-webhook.ts) còn tính hạn gia hạn từ store đã đọc ngoài transaction; transaction chỉ đọc dấu giao dịch. Hai giao dịch khác nhau đồng thời có thể cùng tính từ một hạn cũ. Cần đọc cửa hàng và dấu giao dịch trong transaction thật, tính hạn trong callback, rồi ghi cùng nhau.

Tài liệu đối chiếu: [WriteBatch](https://cloud.google.com/nodejs/docs/reference/firestore/latest/firestore/writebatch), [Transaction](https://cloud.google.com/nodejs/docs/reference/firestore/latest/firestore/transaction).

## 13. Những chi phí tăng theo tổng số cửa hàng

[SuperAdminView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v2/src/components/SuperAdminView.tsx):

- Dòng 166, 170: tải toàn bộ stores và users để tính thống kê.
- `fetchData()` lại chạy sau nhiều thao tác chỉnh sửa.
- Dòng 509: xuất dữ liệu đọc toàn bộ collection của toàn hệ thống.
- Dòng 533–559: dọn hệ thống quét collection toàn cục.

Ví dụ 500 quán × 10 nhân viên: mỗi fetch quản trị đọc khoảng 500 stores + 5.000 users, ngoài cấu hình/gói. Mười lần refresh đã khoảng 55.000 document, dù không cửa hàng nào mở báo cáo.

Sửa bằng phân trang danh sách quán, số nhân viên/hoạt động lưu sẵn theo quán khi cần, chỉ lấy users của quán đang quản lý. Dọn dữ liệu phải là job có phạm vi, checkpoint và kiểm soát tải. Xuất toàn hệ thống là tác vụ quản trị riêng, không gắn vào refresh dashboard. Không chạy thử các tác vụ xóa/dọn trên production để đo chi phí.

Lookup settings ở App dòng 3931/3959/3977 và payroll dòng 3840 có thể chuyển sang ID xác định. Đây là tối ưu nhỏ hơn báo cáo và listener kho nhưng giúp bỏ truy vấn trước mỗi lần lưu, đồng thời dễ chống trùng.

## 14. Index, fallback và bản build thực sự đang chạy

### Index và lỗi truy vấn

[firestore.indexes.json](sandbox:/workspace/scratch/9a5780e43587/source-v2/firestore.indexes.json) có bốn composite index. Chưa đủ để chứng minh mọi query hiện tại và đề xuất đều chạy được trên production. Cần triển khai, chờ index sẵn sàng và kiểm tra từng query có phạm vi.

Fallback invoices `limit(60)`, cash `limit(50)`, shifts `limit(30)` trong App không có thứ tự thời gian, không tương đương query chính. Lỗi index/quyền/mạng không được biến thành tập dữ liệu bị cắt rồi hiển thị như đầy đủ.

Hiển thị trạng thái chưa tải đủ/lỗi và nút thử lại. Chỉ dùng cache khi biết phạm vi và trạng thái của cache. Màn hình tiền không được hiển thị tổng 0 như kết quả chắc chắn khi tải thất bại.

Các mảng hóa đơn, orders, ghi chú lớn không dùng để query có thể được miễn index phù hợp nhằm giảm index storage và tải ghi. Việc này không làm một `updateDoc` được tính ít hơn một write; kiểm tra query thực tế trước khi bỏ index.

### Mobile build

So sánh nội dung hai ZIP: 12 file trong `android/app/src/main/assets/public` và 15 file trong `ios/App/App/public` không đổi. Vì vậy chỉ nhìn source mới chưa chứng minh APK/IPA đã chứa tối ưu mới.

Workflow iOS có bước build và sync, nên không thể kết luận ứng dụng đang phát hành chắc chắn dùng code cũ. Cần kiểm tra build identifier/commit trên thiết bị thật, chạy lại build và Capacitor sync, xác nhận các query mới xuất hiện ở bản đã cài. API tương đối `/api/...` cũng cần kiểm tra trên môi trường native thực tế.

## 15. Hạn mức miễn phí và khả năng kinh doanh

Firestore Standard có 50.000 document reads và 20.000 document writes miễn phí/ngày cho database đủ điều kiện trong project, không phải mỗi user hay mỗi cửa hàng. Mốc reset theo giờ Pacific. Nguồn: [Google Cloud pricing](https://cloud.google.com/firestore/pricing).

Nếu chia đều, chưa tính tác vụ quản trị và overhead:

| Số cửa hàng | Reads/quán/ngày trong tổng 50K | Writes/quán/ngày trong tổng 20K |
|---:|---:|---:|
| 3 | khoảng 16.667 | khoảng 6.667 |
| 10 | 5.000 | 2.000 |
| 50 | 1.000 | 400 |
| 100 | 500 | 200 |
| 500 | 100 | 40 |

Với code hiện tại, giả sử 100 hóa đơn/quán/ngày, có ca nhưng chưa trừ tồn: bốn ghi cốt lõi/hóa đơn đã là 400 writes/quán/ngày. 100 quán là 40.000 writes/ngày. Như vậy giữ toàn hệ thống miễn phí lâu dài không phải mục tiêu thực tế của kiến trúc hiện tại, kể cả đã giảm reads rất mạnh.

Vượt quota không đồng nghĩa chi phí trả phí không thể duy trì. Cần tính theo giá đúng region và edition của database, gồm storage, băng thông, backend, backup và vận hành, thay vì suy chi phí từ cảm giác “50K đã hết”.

Nếu đơn giá theo 100.000 thao tác là `P_R`, `P_W`, với database được hưởng quota và mức dùng ngày `R_d`, `W_d`:

```text
Chi phí đọc/ghi trong tháng = tổng theo từng ngày d của:
  max(R_d - 50.000, 0) / 100.000 × P_R
  + max(W_d - 20.000, 0) / 100.000 × P_W
```

Đây chưa phải tổng hóa đơn cloud. Không lấy tổng reads cả tháng rồi trừ một quota tháng giả định: phần miễn phí áp dụng theo ngày. Chưa có region và Usage/Billing nên báo cáo không tự gán giá USD/VND cho ứng dụng này.

Mục tiêu kinh doanh nên là chi phí trên cửa hàng/tháng và trên 1.000 hóa đơn, có dự phòng cho giờ cao điểm và lịch sử dài. Không cần quyết định chuyển database chỉ vì chạm quota miễn phí. Trước tiên sửa query, mô hình dữ liệu và đo lại; nếu chi phí hoặc nhu cầu báo cáo vẫn không đạt, mới so sánh phương án backend/database khác bằng tải tương đương.

## 16. Lộ trình thực hiện

### Giai đoạn A — Bảo toàn dữ liệu và quyền

1. Sửa Firebase Auth và API; dùng Admin SDK thật, bỏ các fallback giả thành công/token giả.
2. Sửa ca của order; query ca mở riêng, chống mở trùng.
3. Sửa số dư đầu kỳ, dữ liệu lương, chi phí phân bổ ngày và thao tác hóa đơn lịch sử.
4. Bổ sung chống thanh toán lặp, xử lý đồng thời và quy tắc hủy/điều chỉnh chứng từ.
5. Kiểm thử tenant/role trước khi triển khai rules đóng quyền.

### Giai đoạn B — Giảm chi phí lớn

1. Tổng hợp theo ngày cho dashboard và báo cáo; chi tiết phân trang server.
2. Bỏ fetch cả năm mặc định ở TaxReportView và fetch ba collection cùng lúc khi không cần.
3. Tách catalog/kho; gộp delta nguyên liệu và ghi sổ kho theo nguyên liệu–hóa đơn.
4. Đưa invoices/cash/customers/users về các hook đúng nghiệp vụ.
5. Cache theo khóa truy vấn, gộp request trùng, invalidation, tự đổi ngày kinh doanh.

### Giai đoạn C — Mở rộng có đo lường

1. Phân trang và thống kê riêng cho superadmin.
2. Chuẩn hóa ID settings/payroll, index và schema ngày.
3. Backfill tổng hợp lịch sử bằng job có checkpoint; dự trù reads một lần, không bắt mỗi client tự backfill.
4. So sánh tổng hợp với chứng từ gốc trước khi chuyển báo cáo sang nguồn mới. Chạy đối chiếu trên mẫu/quán thử, tránh dual-read toàn lịch sử trên tất cả máy kéo dài.
5. Xác nhận phiên bản web/APK/IPA và theo dõi vài ngày vận hành thực tế.

Nếu tổng hợp được cập nhật bằng trigger, phải xử lý sự kiện lặp và thứ tự cập nhật; nếu cập nhật trong checkout, bảo đảm cùng giao dịch nghiệp vụ. Mọi đường ghi invoice/thu chi, kể cả sửa, hoàn, nhập dữ liệu và migration, phải tuân thủ cơ chế mới.

## 17. Đo lường và điều kiện nghiệm thu

Không ghi một document Firestore cho từng read để đếm read. Dùng log/telemetry có lấy mẫu và giới hạn lưu, hoặc gom theo phiên ngoài collection nghiệp vụ.

Các trường nên ghi: phiên bản build, màn hình/tác vụ, query key đã ẩn thông tin nhạy cảm, storeId được phép sử dụng, số document, nguồn cache/server, thời gian, số lần attach/detach, lỗi/retry. Không đưa thông tin khách hàng hoặc nội dung hóa đơn vào log nếu không cần.

Đối chiếu với Usage/Billing; bộ đếm client không thấy đầy đủ index reads, rule reads, server jobs hoặc các client khác. Không coi emulator/mocks là máy tính hóa đơn production.

| Kịch bản kiểm tra | Điều kiện đạt |
|---|---|
| Order mở ca rồi gọi món | Nhận ca đúng; không phải mở lại; không tạo hai ca |
| Hai máy cùng thanh toán một đơn | Một kết quả thanh toán; không trừ kho/cộng doanh thu hai lần |
| Hai đơn khác nhau dùng cùng nguyên liệu | Tổng tồn và số dư sổ kho đúng |
| Báo cáo với lịch sử 365 ngày | Tổng hợp không tải 36.500 hóa đơn chỉ để tính doanh thu |
| Chuyển kỳ rồi quay lại | Cache có hiệu lực được dùng; không fetch trùng vô ích |
| Hơn 150 bản ghi điểm danh | Lương tháng vẫn đủ dữ liệu |
| Khách ngoài 100 dòng đầu | Tìm/đọc/cập nhật đúng khách |
| Sửa/hủy hóa đơn từng tải lịch sử | Báo cáo, sổ quỹ, kho, ca và tổng hợp thống nhất |
| App mở qua nửa đêm và resume hôm sau | Query ngày/điểm danh dịch đúng, không tích lũy mãi |
| Thiếu index/quyền hoặc mạng lỗi | Không hiển thị số liệu thiếu như kết quả hoàn chỉnh |
| Người quán A truy cập quán B | Bị chặn ở cả Firestore lẫn API |
| APK/IPA mới | Build ID và query thực tế khớp source đã kiểm tra |

## 18. Kiểm chứng đã thực hiện và giới hạn

Đã so sánh hai bản; rà soát các điểm gọi Firestore ở source ứng dụng/API, luồng dữ liệu giữa App và các màn hình; đọc rules, indexes, cấu hình Firebase và gói build.

Đã chạy các kiểm tra Node cô lập, trích trực tiếp đoạn TypeScript của source và thay dependency bằng mock, không gọi mạng:

- Năm vai trò: xác nhận số listener root và cleanup, không có shifts cho order.
- Merge hóa đơn: xác nhận lịch sử thắng live và bản ghi đã xóa ở live còn trong kết quả.
- Cleanup lịch sử: ba query vẫn được gọi sau khi effect đã cleanup.
- Số dư đầu kỳ: cùng logic trả 0 hoặc 500.000 tùy dữ liệu lịch sử đã tải.
- Hai món dùng chung hai nguyên liệu: bốn balance updates và bốn stock-card writes.

Các kiểm tra trên xác nhận logic cục bộ, không thay thế kiểm thử tích hợp React/Firebase, tải đồng thời hay đo billing. Chưa chạy build đầy đủ hoặc thử API với Admin credential thật. Các nhận định về tình trạng triển khai rules, APK/IPA và vùng database phải đối chiếu môi trường đang chạy.

Khuyến nghị thực hiện trước: **sửa P0 để giữ đúng dữ liệu; tiếp theo thay báo cáo đọc chứng từ bằng tổng hợp + phân trang và tách tồn kho khỏi menu; cuối cùng đo chi phí trên mỗi quán để chốt mô hình giá thương mại.**
