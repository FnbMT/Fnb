# Fnb Master — Phân tích reads Firestore bản (3)

Ngày kiểm tra: 22/10/2026, giờ Việt Nam. Nguồn: `remix-fnb-master---pos (3).zip`.

## 1. Kết luận quan trọng nhất

**Vẫn còn khả năng giảm reads rất lớn. Hai listener hóa đơn và sổ quỹ đã quay lại đọc toàn bộ lịch sử của cửa hàng rồi mới lọc ngày trên máy. Đây là bước lùi trực tiếp so với query có điều kiện ngày ở bản (2).**

Bản mới có tiến bộ thật: đã thêm thống kê ngày, cache ngoài component, ca riêng cho order, tự đổi ngày, sắp xếp lịch sử kho và gộp nguyên liệu trước khi ghi. Tuy nhiên, `daily_stats` hiện chưa thay thế được các query chi tiết ở Tổng kết. Một số lỗi ngày/cache còn làm số báo cáo sai, nên chưa thể chỉ bỏ các query chi tiết và tin ngay vào thống kê.

Ưu tiên: sửa phạm vi query trước; đồng thời sửa tính đúng của thống kê; sau đó chuyển dashboard sang tổng hợp và chi tiết sang phân trang. Chưa cần đổi hệ quản trị dữ liệu để xử lý các điểm này.

Đã kiểm tra code và chạy các phép kiểm tra cô lập trên đoạn source thực tế. Chưa truy cập database production, Usage/Billing hay chạy APK/IPA đang phát hành. Các con số reads trong báo cáo là mô hình với giả định rõ ràng, không phải số đo tài khoản Firebase. Không chỉnh sửa source ứng dụng hoặc chạy script backfill production.

## 2. Những điểm đã cải thiện so với đợt kiểm tra trước

| Hạng mục | Kết quả ở bản mới |
|---|---|
| Ca cho nhân viên order | Có listener `storeId + staffId + status=open` và đặt activeShift sau mở ca |
| Ca mở quá ba ngày | Đã tách ca đang mở khỏi lịch sử ca đóng |
| Điểm danh cá nhân | Có state riêng `myTodayAttendance`, tránh bị danh sách nhân sự ghi đè |
| Chuyển ngày | Có business date theo Việt Nam, kiểm tra mỗi 30 giây và khi focus/resume |
| Kho/nhân sự | Nhiều query đã thêm `orderBy`; đúng hướng nhưng vẫn thiếu filter nghiệp vụ và cursor |
| Gộp nguyên liệu | Đã gộp delta trước khi ghi; kiểm tra hai món dùng chung hai nguyên liệu cho ra hai cập nhật tồn + hai stock cards |
| Thống kê | Checkout ghi `daily_stats` bằng increment trong cùng batch hóa đơn |
| Cache báo cáo | Có Map ngoài component, giữ được khi đổi màn hình trong cùng lần chạy app |
| Xóa hóa đơn cũ | Có đọc hóa đơn theo ID khi không có trong state hôm nay; có dọn hóa đơn ở cache kỳ đang xem |
| Backfill | Đã có script tạo thống kê lịch sử, nhưng còn rủi ro phạm vi/chạy đồng thời và không thống nhất ngày với checkout |

Số listener root kiểm tra được: admin/cashier/order_cashier = 12; order = 7; kitchen = 6. Bản trước lần lượt là 11, 6, 6. Listener tăng để phục hồi ca không phải vấn đề chính; phạm vi document của từng listener mới là trọng tâm.

## 3. P0 về reads: khôi phục điều kiện ngày ở server

Nguồn: [App.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v3/src/App.tsx), dòng 2711 và 2726.

Code hiện tại có dạng:

```ts
const invoicesQuery = query(
  collection(db, 'invoices'),
  where('storeId', '==', storeId)
);
// Sau khi nhận snapshot:
const todayInvoices = allStoreInvoices.filter(inv => inv.date >= startOfTodayIso);
```

`cash_transactions` dùng cùng cách. Điều kiện ngày chỉ tồn tại trong JavaScript sau khi tải dữ liệu. Vì vậy, chọn “hôm nay” trên giao diện không làm Firestore chỉ trả hóa đơn hôm nay.

**Mô hình tải đầu, giả định mỗi query phải lấy đầy đủ kết quả từ server:**

| Giả định | Giá trị |
|---|---:|
| Hóa đơn/quán/ngày | 100 |
| Lịch sử tích lũy | 90 ngày |
| Hóa đơn/quán | 9.000 |
| Giao dịch bán hàng tương ứng/quán | 9.000 |
| Riêng hai listener/một máy quản lý | khoảng 18.000 document |
| Ba quán, mỗi quán một máy như vậy | khoảng 54.000 document |

Đã vượt 50K chỉ từ tải đầu hai tập dữ liệu này, chưa tính menu, bàn, khách, ca. Thêm máy thu ngân/order_cashier sẽ thêm các phiên nhận dữ liệu riêng. Đây không có nghĩa mỗi lần một hóa đơn thay đổi sẽ đọc lại cả 18.000 document: cần phân biệt tải đầu và cập nhật listener.

**Bản vá nên làm trước:** đưa cận ngày vào chính query.

```ts
// Với schema date là chuỗi ISO UTC như code hiện tại.
const dayStart = new Date(`${currentBusinessDate}T00:00:00+07:00`);
const nextDayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

const todayInvoicesQuery = query(
  collection(db, 'invoices'),
  where('storeId', '==', storeId),
  where('date', '>=', dayStart.toISOString()),
  where('date', '<', nextDayStart.toISOString())
);
```

Áp dụng tương tự cho sổ quỹ. Đây là mẫu đề xuất, chưa được tích hợp. Khi triển khai, xác nhận mọi document dùng kiểu/ngày nhất quán và composite index tương ứng đã sẵn sàng. Không bỏ điều kiện ngày để né lỗi index.

Trong cùng ví dụ, nếu đã có 100 hóa đơn hôm nay, hai tập dữ liệu giảm từ 18.000 xuống khoảng 200 document/máy. Riêng phạm vi tải đầu giảm khoảng 98,9%; không phải cam kết giảm 98,9% tổng bill toàn ứng dụng.

`currentBusinessDate` hiện nằm trong dependency của toàn bộ effect root. Khi đổi ngày, cả menu, bàn, settings, users... đều bị hủy/gắn lại. Nên tách hook theo ngày khỏi hook dữ liệu cố định. Timer 30 giây chỉ kiểm tra thời gian local; không phải cứ 30 giây là có query Firestore mới.

## 4. P1: Tổng kết đã có daily_stats nhưng vẫn đọc chi tiết toàn lịch sử

Nguồn: [SummaryView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v3/src/components/SummaryView.tsx), effect dòng 175.

| Query | Dòng | Phạm vi thực sự |
|---|---:|---|
| Daily stats | 233 | Đúng ngày/tháng/năm được chọn |
| Invoices | 249 | Toàn bộ hóa đơn của quán |
| Cash transactions | 268 | Toàn bộ sổ quỹ của quán |
| Inventory logs | 287 | Toàn bộ nhật ký kho của quán khi mở tab kho |

Hóa đơn, sổ quỹ và kho đều lọc kỳ sau `getDocs`. Query invoices/cash vẫn chạy dù `daily_stats` đã có kết quả. Ngay mở ngày hôm nay cũng đi qua luồng này; bản trước còn tránh historical fetch khi xem hôm nay.

**Lưu ý khi tính bill:** hai query invoices/cash ở Tổng kết giống query root hiện tại. Không được mặc định cộng mọi lời gọi thành hai lần bill đầy đủ; cache và trạng thái đồng bộ/SDK có thể tái sử dụng kết quả. Phát hiện chắc chắn là phạm vi dữ liệu đang quá rộng. Sau khi sửa root về hôm nay mà để Tổng kết như cũ, Tổng kết sẽ vẫn yêu cầu toàn lịch sử. Vì vậy cần sửa cả hai nơi.

Các trang trong Tổng kết vẫn dùng `data.slice()` ở dòng 641. Chưa có `startAfter` trong source ứng dụng. Nút sang trang không phải phân trang Firestore.

**Thiết kế thay thế:**

| Tác vụ | Nguồn dữ liệu | Lượng lấy ban đầu dự kiến |
|---|---|---|
| Thẻ doanh thu hôm nay | Document tổng hợp hôm nay | 1 document + thay đổi cần nhận |
| Biểu đồ theo ngày của tháng | Daily stats của tháng | Tối đa 28–31 document |
| Biểu đồ theo ngày của năm | Daily stats của năm | Tối đa 365/366 document |
| Danh sách hóa đơn | Query đúng kỳ + cursor | 20–50 hóa đơn/trang |
| Sổ quỹ chi tiết | Query đúng kỳ + cursor | 20–50 giao dịch/trang |
| Thẻ kho một nguyên liệu | storeId + itemId + thời gian + cursor | Một trang |
| Tổng theo món | Tổng hợp món theo kỳ hoặc đọc chi tiết có chủ đích | Thiết kế riêng, không suy từ một trang hóa đơn |

Document `DailyStats` hiện chỉ có doanh thu, tiền bán theo phương thức, số hóa đơn và giảm giá. Nó chưa chứa đủ giá vốn, thu ngoài bán hàng, chi phí và số dư để thay tất cả báo cáo. Cần bổ sung đúng chỉ tiêu cần dùng và cập nhật ở mọi đường ghi tương ứng. Thêm trường vào lần ghi stats đang có có thể không cần thêm một document write nữa.

Không dùng tổng của 50 hóa đơn trang đầu làm tổng doanh thu tháng. Không âm thầm thay giá vốn thật bằng tỷ lệ mặc định. `SummaryView` dòng 521 hiện có tỷ lệ giá vốn mặc định 0,35 khi thiếu mẫu; khi chuyển sang tổng hợp, cần tổng giá vốn đúng hoặc ghi rõ là số ước tính.

Firebase có hướng dẫn [aggregation lúc ghi](https://firebase.google.com/docs/firestore/solutions/aggregation) và [phân trang cursor](https://firebase.google.com/docs/firestore/query-data/query-cursors). Với quán nhỏ, thống kê ngày là điểm bắt đầu hợp lý; chỉ thêm thống kê tháng/năm khi lượng đọc chứng minh cần thiết, tránh tăng writes cho mọi hóa đơn một cách không cần thiết.

## 5. Phải sửa tính đúng của daily_stats trước khi dùng làm nguồn báo cáo chính

### 5.1. Checkout và backfill đang chia ngày khác nhau

`App.tsx` dòng 3800 tạo `invoice.date` bằng `new Date().toISOString()`; dòng 3820 dùng `invoice.date.slice(0, 10)` làm ngày thống kê. Hàm xóa hóa đơn dòng 3541 cũng dùng cách này.

[backfill_daily_stats.ts](sandbox:/workspace/scratch/9a5780e43587/source-v3/scripts/backfill_daily_stats.ts), dòng 38, lại chuyển sang `Asia/Ho_Chi_Minh`.

Ví dụ được kiểm tra:

```text
Thanh toán:       22/10/2026, 06:30 giờ Việt Nam
invoice.date:    2026-10-21T23:30:00.000Z
Checkout ghi:   daily_stats ngày 21/10
Backfill ghi:   daily_stats ngày 22/10
```

Đây là lỗi đặc biệt đáng chú ý với quán bán sáng trước 7h. Ở Tổng kết tháng hiện tại, code bỏ stats hôm nay rồi cộng hóa đơn live hôm nay. Nhưng hóa đơn 6h30 đã nằm nhầm trong stats hôm qua, nên có thể được cộng thêm lần nữa.

Kiểm tra đoạn `statsAggregates` thực tế: một hóa đơn 100.000đ duy nhất trong tình huống trên cho ra tổng tháng **200.000đ**.

Sửa bằng một hàm chung lấy ngày kinh doanh từ thời điểm hóa đơn và múi giờ quán. Lưu `businessDate` vào hóa đơn; checkout, hủy, backfill và query tổng hợp dùng cùng giá trị. Không chỉ thay thành “ngày hiện tại” trong hàm hủy vì có thể hủy hóa đơn quá khứ. Dữ liệu stats đã chia ngày sai cần tái tạo/đối soát có phạm vi.

### 5.2. Có một dòng thống kê không có nghĩa đã đủ cả năm

Nguồn: [TaxReportView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v3/src/components/TaxReportView.tsx), dòng 53–78.

Nếu query stats năm trả ít nhất một document, code dùng stats và không tải hóa đơn lịch sử. Quán nâng cấp giữa năm có thể chỉ có stats từ ngày nâng cấp; phần trước đó bị bỏ sót nếu backfill chưa hoàn chỉnh.

Nếu stats hoàn toàn rỗng, fallback đọc hóa đơn theo `fromDate/toDate`, tốt hơn đọc cả năm. Tuy nhiên, `mergedDailyStats` lại tạo một dòng synthetic cho hôm nay khi có doanh thu live. Các phép cộng quý và bảng ngày thấy mảng stats không rỗng sẽ ưu tiên nó và bỏ nguồn hóa đơn fallback.

Kiểm tra mẫu: 900.000đ hóa đơn cũ + 100.000đ hôm nay, chưa có daily_stats. Dữ liệu hóa đơn đã tải đủ mẫu nhưng tổng quý hiển thị **100.000đ**, không phải 1.000.000đ.

Cần metadata về phạm vi thống kê đã hoàn thành, chẳng hạn ngày bắt đầu, ngày kết thúc, phiên bản và trạng thái backfill. Với một khoảng thiếu stats, bổ sung đúng khoảng thiếu hoặc hiển thị trạng thái chưa hoàn tất; không coi “không có document” luôn là “doanh thu 0”.

### 5.3. Math.max che lỗi và không xử lý được doanh thu giảm

TaxReportView dòng 127 dùng `Math.max(stats cũ, live)`; Tổng kết dòng 509 và các thẻ tiền cũng chọn số lớn hơn giữa các nguồn. Đây không phải cơ chế đồng bộ dữ liệu.

Kiểm tra: stats đang cache 200.000đ; sau hủy hóa đơn, live còn 100.000đ. Logic TaxReport hiện vẫn giữ **200.000đ**. Khi xóa hết hóa đơn hôm nay, nhánh `todayLiveRevenue > 0` không cập nhật dòng cũ.

Chọn một nguồn có thẩm quyền cho mỗi khoảng ngày. Nếu dùng live làm nguồn hôm nay, thay thế hẳn phần hôm nay khi dữ liệu live đã tải đủ, kể cả bằng 0; không chọn số lớn hơn. Phân biệt trạng thái “chưa tải xong” với “đã tải, không có hóa đơn”.

### 5.4. Ghi/hủy chưa đảm bảo thống kê luôn đúng khi nhiều máy thao tác

Checkout đã increment stats trong cùng batch hóa đơn, đây là cải thiện đúng. Nhưng `checkoutLockRef` chỉ là Set trong một phiên ứng dụng; không chống hai máy thanh toán cùng một đơn. Kiểm tra đơn hợp lệ cũng dựa vào state trên máy, và `validOrders` chưa được dùng thay cho `ordersToPay` khi tính tiền/tạo hóa đơn.

Hủy hóa đơn gồm nhiều bước tách rời; cập nhật stats ở cuối còn nuốt lỗi. Hóa đơn có thể đã xóa nhưng thống kê chưa giảm. Với lịch sử đã backfill theo giờ Việt Nam, thao tác hủy trước 7h còn có thể giảm nhầm ngày UTC.

Cần mã nghiệp vụ cố định để chống xử lý lặp và một giao dịch backend đáng tin cậy cho những thay đổi tài chính liên quan. Đây không nhất thiết giảm reads ở bản thân transaction, nhưng là điều kiện để bỏ việc tải toàn bộ chứng từ chỉ nhằm dò sai số.

## 6. Cache đã thêm nhưng hết hạn không tải lại

`SummaryView.tsx`, dòng 186 kiểm tra TTL 5 phút. Nhưng khi cache hết hạn, dòng 204 vẫn lấy entry cũ; các khối sau chỉ fetch khi không có `currentEntry.dailyStats/invoices/cash`.

Mảng cũ hoặc mảng rỗng đều là giá trị truthy. Nếu đã fetch một lần, hết hạn không dẫn đến fetch mới; dòng 298 lại gán timestamp mới. Entry có thể sống mãi trong lần chạy ứng dụng.

Kiểm tra thực tế bằng mock thời gian: lượt đầu phát ba query; sau sáu phút, quay lại cùng kỳ phát **0 query**, đồng thời làm mới timestamp cache cũ. Đây là tiết kiệm reads bằng dữ liệu cũ, không phải cache đúng.

Nên sửa:

1. Cache còn hiệu lực thì dùng; hết hạn thì đánh dấu stale và thật sự nạp lại phần cần thiết.
2. Tách cache theo dữ liệu/phạm vi, tránh yêu cầu có cả invoices và cash mới được dùng thống kê.
3. Lưu Promise cho query đang chạy để các yêu cầu giống nhau dùng chung; kiểm tra request còn cần trước khi khởi động query tiếp theo.
4. Khi sửa/hủy hóa đơn, vô hiệu hóa ngày, tháng, năm liên quan và cache báo cáo thuế; không chỉ sửa mảng của khóa kỳ đang xem.
5. Kỳ đã chốt dùng cache lâu hơn kỳ hiện tại; có phiên bản để xử lý điều chỉnh quá khứ.
6. Giới hạn số entry và dọn khi đổi tài khoản/cửa hàng phù hợp.

Handler xóa ở dòng 1630 đã dọn historicalInvoices/historicalCash và cache kỳ hiện tại, nhưng chưa sửa `dailyStats`, các kỳ chồng lấn và `taxStatsCache`. Hủy từ máy khác cũng chưa làm các cache này mất hiệu lực.

`activeRequestId`/`isMounted` hiện chỉ bảo vệ setState cuối cùng. Kiểm tra sau cleanup vẫn phát tiếp các query stats, invoices, cash. Không thể thu hồi reads của request đã gửi; cần tránh khởi động request kế tiếp khi đã đổi màn hình/kỳ.

## 7. P1 tiếp theo: tách tồn kho khỏi menu và giảm listener nền

`App.tsx` dòng 2560: mọi vai trò vẫn nghe toàn bộ `menu`. Dòng 3991: mỗi thanh toán vẫn cập nhật `stock` ngay trong menu. Gộp delta đã giảm số lần ghi, nhưng số dư nguyên liệu vẫn được phát tới các thiết bị không cần số tồn chi tiết.

Ví dụ năm máy/quán, một máy thanh toán và bốn máy còn lại, 100 hóa đơn/ngày × bốn nguyên liệu khác nhau/hóa đơn: có thể có `4 × 100 × 4 = 1.600` cập nhật document tới các máy còn lại trong ngày, chỉ riêng phần kho. Đây là mô hình kết nối hoạt động, không phải số đo billing.

Đề xuất tách danh mục ít đổi khỏi số dư kho. Máy order cần giá/tên/công thức hiển thị và trạng thái có thể bán; màn hình kho/backend mới cần balance chi tiết. Nếu cần báo hết món realtime, phát thay đổi khả dụng khi trạng thái đổi. Không làm việc tách này khiến kiểm tra hết hàng hoặc trừ công thức/addon bị bỏ qua.

Các listener nền còn có thể thu hẹp:

| Dữ liệu | Hiện tại | Đề xuất |
|---|---|---|
| Hóa đơn/thu chi | Mọi màn hình của admin/manager/cashier/order_cashier | Chỉ khi màn hình/nghiệp vụ cần; chủ quán xem tổng hợp nhỏ |
| Ca đã đóng | Luôn nghe ba ngày lịch sử | Tải khi mở lịch sử; thông báo chênh lệch chưa xử lý dùng query riêng |
| Users | Luôn nghe toàn bộ nhân viên quán | Chỉ màn hình quản lý cần; thông tin người thao tác lấy từ phiên xác thực |
| Customers | Luôn nghe 100 khách | Tìm theo tác vụ, đọc khách đã chọn theo ID; danh sách có phân trang |
| Logs/payroll | Cứ mở Tổng kết là nghe cả hai | Chỉ tab con thực sự cần |
| Menu/settings/groups | Realtime chung | Giữ realtime nếu cần, hoặc cache theo version cho phần ít đổi |

Không tắt luồng báo bếp, trạng thái bàn hay cảnh báo chênh lệch mà chủ quán cần realtime. Những luồng đó nên có query nhỏ đúng nhiệm vụ. Cũng không có một quy tắc “luôn ngắt listener khi ẩn tab” cho mọi thiết bị: cần cân nhắc vận hành bếp/in và chi phí kết nối lại.

## 8. Tăng limit chưa giải quyết bài toán kho/lương

`App.tsx` đã tăng stock card từ 50 lên 100, attendance từ 150 lên 300 và thêm sắp xếp. Đây là lấy nhiều dữ liệu hơn, chưa phải tối ưu reads theo đúng nhu cầu.

- Xem lương cá nhân vẫn tải 300 attendance của toàn quán và 50 payroll, rồi lọc người/tháng ở component.
- Chọn tháng lương khác không thay query vì effect chỉ phụ thuộc storeId/view.
- Stock card lấy 100 dòng của mọi nguyên liệu rồi mới lọc item tại InventoryView dòng 342.
- Các fallback bỏ orderBy vẫn trả tập dữ liệu không bảo đảm thứ tự thời gian cần xem.

Với cá nhân chỉ cần 30 bản ghi trong tháng, tải 300 bản ghi quán là gấp mười lần phạm vi cần thiết trong ví dụ và vẫn có thể thiếu người/tháng đó.

Query nên lọc tháng/người hoặc thời gian/item ngay ở server. Đối với danh sách dài, dùng cursor. Đối với tổng lương tháng, dùng bản chốt đầy đủ và chỉ tải chi tiết khi xem.

Sổ quỹ đầu kỳ cũng chưa đúng hoàn toàn: Tổng kết dòng 386 đặt đầu kỳ bằng 0 với tháng/năm, còn ngày thì cộng startCash của các ca đã tải. Nếu ca sau nhận lại tiền ca trước, cộng startCash có thể đếm tiền hai lần; ca lịch sử ngoài cửa sổ ba ngày cũng không đủ. Cần phân biệt tiền đầu ca với số dư quỹ đầu kỳ và lưu checkpoint số dư phù hợp, thay vì giải quyết bằng tải rộng lịch sử.

## 9. Các nguồn reads khác cần biết

### Backfill lịch sử

Script `scripts/backfill_daily_stats.ts` dòng 17 đọc **toàn bộ invoices của mọi quán** mỗi lần chạy. Đây là chi phí migration, không phải thao tác UI hằng ngày. Nếu chạy khi hệ thống có 50.000 hóa đơn, riêng lần quét đã đọc khoảng 50.000 document. Không tìm thấy nó được nối vào lịch chạy tự động trong các file đã kiểm tra; không kết luận nó đang chạy định kỳ trên production.

Nên sửa script để chọn quán/phạm vi, có cursor và checkpoint, chạy phía server xác thực. Phân trang giảm tải mỗi đợt và hỗ trợ tiếp tục, không làm tổng reads của lần backfill toàn bộ giảm một cách kỳ diệu.

Hiện script ghi đè tổng đã tính. Nếu có thanh toán sau lúc đọc invoices nhưng trước lúc ghi stats, tổng cũ có thể đè increment mới. Tái tạo theo phiên bản/cutoff và đối soát trước chuyển nguồn đọc; tránh liên tục chạy lại toàn hệ thống để sửa báo cáo. Script cũng không dọn các document stats sai ngày hoặc không còn hóa đơn, nên chạy lại chưa chắc sửa hết lỗi UTC hiện có.

### Superadmin

[SuperAdminView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v3/src/components/SuperAdminView.tsx), dòng 166 và 170 vẫn đọc toàn bộ stores/users để tính thống kê. Xuất dữ liệu dòng 513 và dọn hệ thống dòng 549 quét collection toàn cục.

Khi số quán tăng, quản trị viên cũng có thể tạo reads lớn dù quán không thao tác. Phân trang cửa hàng, lấy nhân viên của quán được chọn, lưu chỉ tiêu quản trị nhỏ khi thật sự cần. Tách export/cleanup thành job có phạm vi; không chạy thử tác vụ xóa để đo.

### Tìm khách hàng

[CustomerView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v3/src/components/CustomerView.tsx), dòng 42–66 đã thêm tìm phone chính xác ở server với debounce 350 ms. Đây là tiến bộ để tìm ngoài 100 khách. Tuy nhiên, mọi từ khóa từ ba ký tự đều có thể kích hoạt query, kể cả tên hoặc số điện thoại chưa nhập xong, và không kiểm tra đã có kết quả local hay chưa.

Chuẩn hóa số điện thoại; chỉ query khi đủ điều kiện tìm hoặc người dùng xác nhận; cache kết quả tìm phù hợp và chống kết quả request cũ ghi đè request mới. Tra cứu một khách nên có giới hạn hợp lý/chỉ mục khóa duy nhất theo quán. Đây là tối ưu nhỏ hơn hai listener toàn lịch sử.

### Rules/API

[firestore.rules](sandbox:/workspace/scratch/9a5780e43587/source-v3/firestore.rules) vẫn cho đọc/ghi công khai phần lớn collection, kể cả daily_stats. system/app_settings/packages ở bản mới cũng cho ghi vô điều kiện.

API save-user/change-password/delete-user đã thêm kiểm tra `caller`, nhưng đây là object do client gửi và chỉ kiểm tra khi object tồn tại. Chưa thay được xác minh ID token/tenant/role. Lớp Admin adapter còn nhánh token giả và fallback transaction gọi get/update riêng.

Nếu triển khai như vậy, hệ thống chưa ngăn được truy cập không hợp lệ tiêu thụ quota. Chưa có bằng chứng bị lạm dụng. Hoàn thiện Auth/API rồi triển khai rules đúng quyền; không đóng rules khi luồng Firebase Auth còn lỗi và cũng không giữ quyền công khai để tránh lỗi truy vấn.

## 10. Mẫu sửa phạm vi và phân trang

Với lịch sử hóa đơn, dùng range trên server và cursor theo document snapshot:

```ts
const filters = [
  where('storeId', '==', storeId),
  where('date', '>=', startIso),
  where('date', '<', nextPeriodStartIso),
  orderBy('date', 'desc'),
];

const q = lastSnapshot
  ? query(collection(db, 'invoices'), ...filters, startAfter(lastSnapshot), limit(30))
  : query(collection(db, 'invoices'), ...filters, limit(30));
```

Với stats ngày, ID đã xác định `${storeId}_${businessDate}`, có thể đọc/listen document trực tiếp. Với tháng/năm dùng query stats đúng kỳ. Một query trả một document không tự đắt hơn getDoc một document về số document reads; lợi ích ID cố định là rõ ràng nguồn dữ liệu, không cần tìm kiếm/không tạo trùng.

`firestore.indexes.json` đã bổ sung nhiều index đúng hướng. Cần kiểm tra chúng thực sự được triển khai và khớp query mới. Khi query lỗi, hiển thị chưa tải đủ và retry có kiểm soát; không tự chuyển thành tải toàn bộ hoặc lấy tập limit sai nghĩa.

Phải sửa các nơi sau cùng nhau: App root, Summary invoices/cash/logs, TaxReport fallback, các hook màn hình chi tiết. Sửa riêng App root sẽ không chặn được Tổng kết mở lại toàn bộ lịch sử.

## 11. Lộ trình khuyến nghị theo lợi ích/độ phức tạp

| Thứ tự | Việc thực hiện | Lợi ích chính | Điều kiện nghiệm thu |
|---|---|---|---|
| 1 | Khôi phục where ngày ở App và Summary; bỏ mọi query chi tiết toàn quán không cần thiết | Giảm phạm vi đọc lớn nhất ngay | Mở app/hôm nay không trả hóa đơn tháng trước |
| 2 | Đồng nhất businessDate; sửa hủy/Math.max/coverage thống kê | Làm stats đáng tin để thay chi tiết | Hóa đơn 06:30, hủy và lịch sử nâng cấp đều đúng |
| 3 | Tổng hợp cho thẻ/biểu đồ; cursor cho danh sách | Chi phí báo cáo không tăng tuyến tính với số hóa đơn | Xem tổng tháng chỉ đọc stats; trang chi tiết chỉ đọc số dòng cần |
| 4 | Sửa TTL, invalidation và request đang chạy | Tránh dữ liệu cũ và yêu cầu không cần thiết | Hết TTL nạp lại phần cần; sửa/hủy làm đúng các kỳ liên quan |
| 5 | Query chấm công/kho/khách theo tác vụ | Bớt dữ liệu thừa và hết thiếu dữ liệu do limit | Xem cá nhân không tải toàn quán; thẻ kho đúng item |
| 6 | Tách catalog và balance; thu hẹp listener nền | Giảm reads theo số thiết bị và số hóa đơn | Máy bếp/order không nhận mọi thay đổi số tồn |
| 7 | Phân trang quản trị, backfill có phạm vi; Auth/rules đầy đủ | Chi phí và truy cập kiểm soát được khi nhiều quán | Quán A không truy cập B; job không tự quét mọi quán |

Các lỗi về quyền và tính đúng thanh toán cần được xử lý trước khi triển khai rộng; thứ tự trong bảng thể hiện trọng tâm giảm reads, không phải cho phép trì hoãn bảo vệ dữ liệu production.

## 12. Kiểm thử đã chạy và cách đo sau sửa

Đã chạy 12 trường hợp kiểm tra cô lập bằng Node, trích trực tiếp các đoạn TypeScript và mock Firestore. Kết quả:

| Phép kiểm tra | Kết quả |
|---|---|
| Root của năm vai trò | 12/12/12/7/6 listener; invoices/cash chỉ có điều kiện storeId |
| Snapshot có hóa đơn cũ và mới | Cả hai đến callback rồi chỉ một được đưa lên UI |
| Tổng kết mặc định hôm nay | Vẫn gọi stats + invoices toàn quán + cash toàn quán |
| Cache sau sáu phút | Không fetch mới, timestamp cũ được làm mới |
| Cleanup Tổng kết | Ba query vẫn được phát |
| Hóa đơn 06:30 Việt Nam | Ghi stats ngày trước; tổng tháng mẫu bị nhân đôi |
| Tax fallback có doanh thu live hôm nay | Bỏ qua doanh thu lịch sử đã tải trong mẫu |
| Tax sau hủy một hóa đơn | Math.max giữ số doanh thu cũ |
| Gộp hai nguyên liệu chung | Hai balance updates + hai stock cards, đã cải thiện |

Mocks xác nhận logic, không đo billable reads hoặc thay thế integration/load test. Chưa build toàn bộ ứng dụng hay chạy backend thật.

Sau sửa, đo ít nhất ba tình huống: một máy mới chưa có cache, một phiên đang mở ổn định, và kết nối lại sau thời gian offline. Ghi query key, màn hình, số document trả về, cache/server, thời điểm attach/detach, lỗi và phiên bản app; đối chiếu Usage/Billing. Không dùng `snapshot.size` của mọi callback làm số reads bị tính tiền và không ghi một document Firestore cho từng read chỉ để đo reads.

Theo [billing Firestore](https://firebase.google.com/docs/firestore/pricing), cache không loại bỏ reads cho các thay đổi; persistence có quy định tính lại query khi ngắt kết nối quá 30 phút. Không nhân số callback với toàn bộ kích thước snapshot để kết luận chi phí.

Kiểm tra bundle trong ZIP: không tìm thấy chuỗi `daily_stats` trong các file JS public đóng gói sẵn của Android (6 file JS) và iOS (10 file JS). Điều này không chứng minh bản trên cửa hàng ứng dụng đang cũ vì pipeline có thể build/sync lại, nhưng cần xác nhận build ID thực tế và chạy build/Capacitor sync trước khi đánh giá tối ưu trên điện thoại.

**Việc nên làm đầu tiên là sửa năm query chi tiết đang lọc sau tải trong App/Summary, rồi sửa ngày và độ đầy đủ của daily_stats để có thể bỏ tải chi tiết khỏi các màn hình chỉ cần tổng.**
