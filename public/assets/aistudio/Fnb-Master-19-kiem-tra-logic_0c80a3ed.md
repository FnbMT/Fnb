# Fnb Master — Kiểm tra logic và tính toàn vẹn dữ liệu bản 19

Ngày kiểm tra: 30/10/2026, giờ Việt Nam. Nguồn: `remix-fnb-master---pos (19).zip`.

## Kết luận

Bản này đã cải thiện luồng thanh toán bằng transaction, khóa chống lặp và snapshot giá vốn. Tuy nhiên, chưa đáp ứng yêu cầu số liệu luôn đầy đủ và khớp thực tế. Vẫn có đường xử lý làm mất đơn, sai tồn kho, ghi trùng hóa đơn và lệch báo cáo/ca.

Đây là kiểm tra mã nguồn và mô phỏng mức hàm, không phải kết luận rằng mọi cửa hàng đang gặp tất cả lỗi. Một số lỗi chỉ xuất hiện khi nhiều thiết bị thao tác, kết nối lỗi hoặc dữ liệu cũ và mới cùng tồn tại.

Đã chạy 17 tình huống trên các hàm/callback trích trực tiếp từ mã nguồn: 15 tình huống tái hiện sai lệch và 2 ca đối chứng hoạt động đúng. Các tình huống có thể thuộc cùng một nhóm lỗi; không hiểu là 15 lỗi độc lập.

Không sửa mã nguồn ứng dụng. Đã đối chiếu byte của toàn bộ 305 tệp trong bản giải nén với ZIP gốc: 0 tệp thay đổi, bao gồm toàn bộ YAML, iOS, Android, cấu hình và khai báo phụ thuộc.

## Phạm vi và giới hạn

- Kiểm tra gọi/sửa món, cập nhật bếp, gộp/chuyển bàn, thanh toán, hủy hóa đơn, thu chi, nhập/kiểm kho, báo cáo ngày/tháng/năm, dữ liệu khách hàng, chấm công và lương, migrate/backfill.
- Kiểm thử dùng Node để bỏ chú thích kiểu TypeScript rồi chạy chính hàm của ứng dụng với dữ liệu giả lập và lớp Firestore trong bộ nhớ. Không viết lại thuật toán nghiệp vụ để thay cho mã đang kiểm tra.
- Lớp giả lập không kiểm chứng mạng Firebase thực tế, Firestore Rules, transaction retry do contention, IndexedDB/offline persistence, React lifecycle đầy đủ hoặc native iOS/Android.
- Không kết nối, đọc hoặc thay đổi cơ sở dữ liệu cửa hàng thật. Không chạy migration/backfill vào dữ liệu thật.
- Không chạy lại archive iOS hoặc tạo APK. Không có môi trường macOS/Xcode và Android build để xác nhận hai bản native trong lần kiểm tra này. Thành công trên TestFlight là thông tin bạn cung cấp.
- Không thay đổi dependency, không chạy lệnh cập nhật lockfile hoặc nâng phiên bản.

P1 dưới đây là lỗi nên sửa trước khi tin dùng số liệu để đối soát. P2 là lỗi có điều kiện, sai cách hiển thị hoặc thiếu đảm bảo độ đầy đủ cần hoàn thiện.

## Các lỗi ưu tiên

### 1. P1 — Gọi món, sửa món và báo bếp có thể ghi đè đơn của nhau

**Vị trí:** `src/App.tsx:3664` (`handleUpdateTableOrders`), `src/App.tsx:3675` (`handleUpdateOrder`), `src/App.tsx:3312` và `src/App.tsx:793` (sửa món qua `onUpdateTable`).

Các hàm lấy mảng `orders` từ state của thiết bị rồi ghi lại toàn bộ mảng bằng `updateDoc`. Không đọc/soát phiên bản hiện tại của bàn trong transaction.

**Tái hiện:** một dòng món đang có 1 suất; máy A thêm 1 và máy B thêm 2 từ cùng ảnh chụp dữ liệu. Đúng ra phải có 4 suất; kết quả mô phỏng chỉ còn 3. Một ca khác: máy phục vụ đã thêm đơn s2, bếp ghi trạng thái từ danh sách chỉ có s1; đơn s2 biến mất.

**Hậu quả:** thiếu món trên màn hình, thiếu tiền khi thanh toán; một cập nhật bếp đến muộn còn có thể đưa đơn đã thanh toán trở lại bàn.

**Sửa:** mọi thay đổi đơn trên bàn phải dùng transaction đọc bản hiện tại; gửi thao tác cụ thể theo session/item ID, không gửi cả ảnh chụp mảng cũ. Bếp chỉ được đổi trạng thái của phần tử còn tồn tại; thao tác thêm món cần operation ID cố định để chống gửi lại. Sửa món phải kiểm tra phiên bản, lưu vết giảm/hủy và cập nhật đồng bộ.

### 2. P1 — Gộp/chuyển bàn chưa là một giao dịch nguyên tử

**Vị trí:** `src/App.tsx:4139`, `src/App.tsx:4175`.

Gộp bàn xóa dữ liệu bàn nguồn trước, sau đó mới ghi bàn đích. Chuyển bàn làm theo chiều ngược lại nhưng cũng là hai lần ghi riêng; không kiểm tra bàn đích còn trống trên server tại thời điểm ghi.

**Tái hiện:** cho thao tác ghi bàn đích thất bại sau khi xóa nguồn. Đơn của bàn nguồn không còn ở bàn nào.

**Hậu quả:** gộp có thể mất đơn; chuyển bị gián đoạn có thể để cùng đơn ở cả hai bàn. Khi hai máy cùng chọn một bàn đích tưởng là trống, dữ liệu mới của một máy có thể bị ghi đè.

**Sửa:** transaction đọc tất cả bàn liên quan, kiểm tra đơn/phiên bản/trạng thái, ghi bàn đích và xóa nguồn trong cùng commit. Lưu operation ID cho thao tác gộp/chuyển; giao diện chỉ đóng sau kết quả xác nhận.

### 3. P1 — Nhập kho có thể mất lượng nhập và chỉ ghi được một phần chứng từ

**Vị trí:** `src/App.tsx:3490` đến hàm `handleAuditInventory` tại dòng 3577; `src/components/InventoryView.tsx:50`.

Tồn mới được tính từ `menu` trong state, rồi ghi giá trị tuyệt đối. Tồn kho, giá vốn món liên quan, nhật ký nhập, phiếu chi và thẻ kho được ghi tuần tự, không cùng một commit.

**Tái hiện 1:** tồn đầu 10, hai máy nhập thêm 5 và 7. Kết quả còn 17 thay vì 22.

**Tái hiện 2:** cho ghi phiếu chi thất bại sau bước nhật ký. Tồn đã tăng từ 10 lên 15 và có nhật ký nhập, nhưng không có phiếu chi và thẻ kho.

**Hậu quả:** lượng hàng, giá vốn, chi mua hàng và lịch sử kho không còn khớp nhau; thử lại từ đầu có thể cộng thêm hàng/chứng từ lần nữa.

**Sửa:** operation nhập có ID ổn định; đọc tồn và giá vốn hiện tại trong transaction; cập nhật kho, chứng từ nhập, phiếu chi, daily_stats, ca và thẻ kho nguyên tử. Phần tính giá món phụ thuộc có thể tính lại theo quy trình riêng có trạng thái rõ ràng. Kiểm kho nhiều mặt hàng cũng đang có cùng vấn đề ghi nhiều bước: audit đã tồn tại trước khi mọi mặt hàng cập nhật xong.

### 4. P1 — Đơn tạm có thể thành hai hóa đơn khi thử lại sau lỗi phụ trợ

**Vị trí:** `src/App.tsx:878` (`draft-` + thời gian), `src/App.tsx:4355` (khóa theo session ID), `src/App.tsx:4665` (đồng bộ hết hàng sau commit), `src/App.tsx:4719` (catch trả thất bại).

Mỗi lần bấm thanh toán lại tạo ID `draft-` mới. Sau khi transaction thanh toán đã commit, thao tác đồng bộ trạng thái hết hàng vẫn nằm trong cùng luồng `try`; nếu bước này lỗi, hàm báo thanh toán thất bại. Đơn tạm trong giao diện chưa được xóa vì nhận kết quả false.

**Tái hiện:** thanh toán đơn tạm đã commit, ép đồng bộ hết hàng thất bại, rồi thử lại với ID draft mới như giao diện đang tạo. Có 2 hóa đơn thay vì 1.

**Sửa:** lưu ID đơn tạm và payment operation ID cố định qua mọi lần thử; phân biệt lỗi trước commit và lỗi phụ trợ sau commit. Sau commit phải trả xác nhận thanh toán thành công; đồng bộ trạng thái/in ấn thất bại được xử lý riêng. Tra lại kết quả theo payment operation ID khi kết quả mạng chưa rõ.

**Điểm đang đúng:** với đơn đã lưu có cùng session ID, thử thanh toán lại trong ca đối chứng chỉ tạo 1 hóa đơn.

### 5. P1 — Hủy hóa đơn chưa hoàn nguyên số liệu ca làm việc

**Vị trí:** `src/App.tsx:3838`, đặc biệt phần giảm `daily_stats` từ dòng 4048. Luồng thanh toán cộng ca tại `src/App.tsx:4610`.

Hóa đơn đã lưu `shiftId`. Khi hủy, hàm hoàn kho, sửa thống kê ngày, xóa phiếu thu và lưu audit, nhưng không trừ `totalRevenue`, `totalCash`/`totalTransfer`, `cashIncome`/`transferIncome` của ca tương ứng.

**Tái hiện:** hủy một hóa đơn tiền mặt 100.000đ. Doanh thu ngày về 0 nhưng ca vẫn có doanh thu và tiền mặt 100.000đ.

**Hậu quả:** Tổng kết, Sổ quỹ và màn hình Ca không khớp; tiền dự kiến trong két sai.

**Sửa:** đọc và hoàn nguyên đúng ca theo `invoice.shiftId` trong transaction hủy. Nếu ca đã đóng, lưu điều chỉnh hậu kiểm có liên kết, áp dụng quy tắc rõ ràng cho discrepancy và số kiểm đếm đã chốt; không tự xóa dấu vết kiểm đếm ban đầu.

### 6. P1 — Một thiết bị còn state ca cũ vẫn có thể ghi tiền vào ca đã đóng

**Vị trí:** `src/App.tsx:4610` (checkout), `src/App.tsx:3819` (thu chi), đối chiếu `src/App.tsx:4791` (đóng ca).

Đóng ca có đọc trạng thái hiện tại trong transaction. Nhưng checkout chỉ `txn.update` ca lấy từ state, không `txn.get` để kiểm tra `status === 'open'`; thu chi cũng không kiểm tra trạng thái ca tại commit.

**Tái hiện:** server đã có ca `closed`, máy bán vẫn giữ activeShift cũ. Checkout thành công và cộng thêm 100.000đ vào ca đã đóng; discrepancy vẫn bằng 0 theo số trước đó.

**Sửa:** các giao dịch có ảnh hưởng ca phải đọc và kiểm tra ca trong cùng transaction. Đóng ca và thanh toán/thu chi phải cùng tham gia kiểm soát tranh chấp trên document ca. Mở ca cũng nên dùng khóa/ID ổn định thay cho query rồi `addDoc`, vì hai máy có thể cùng mở hai ca cho một nhân viên.

### 7. P1 — Lương có thể được chốt từ dữ liệu chấm công chưa tải đủ

**Vị trí:** `src/App.tsx:3120` (query), `src/App.tsx:3133` (`limit(100)`); `src/components/UserMgmtView.tsx:126`; `src/components/MyPayrollView.tsx:23`.

Màn hình quản lý chỉ nạp 100 bản ghi chấm công gần nhất cho toàn quán, không nạp đủ theo tháng đang chọn. Nhân viên chỉ nạp 60 bản ghi, không có thứ tự ngày và không phân trang. Công thức lương tính trực tiếp từ danh sách đã tải, vẫn cho chốt lương.

**Tái hiện:** 5 nhân viên, mỗi người 30 ngày, lương ngày 100.000đ. Từ 150 bản ghi đầy đủ phải ra 15.000.000đ. Khi đầu vào bị giới hạn 100 theo query hiện tại, chính hàm tính lương trả tổng 10.000.000đ.

**Hậu quả:** thiếu công, thiếu lương; tháng cũ có thể hiện 0 dù dữ liệu vẫn còn trên server. Nếu đã có bảng lương chốt, việc nạp giới hạn bảng lương cũng có thể không tìm thấy bản chốt của kỳ đang chọn.

**Sửa:** query chính xác tháng và phạm vi nhân viên, tải hết các trang; xác nhận đủ trước chốt. Bản chốt nên có ID `${storeId}_${userId}_${month}` và transaction chống chốt lặp. Đếm công ngày cần quy tắc riêng cho nhiều lượt check-in trong một ngày; không mặc định mỗi lượt là một ngày công. Giờ công chưa checkout phải hiển thị tạm tính, không tự coi 8 giờ là số thực tế để chốt.

### 8. P1 — Chi phí theo ngày bị chia thêm 30, làm lợi nhuận ròng tăng sai

**Vị trí:** `src/components/SummaryView.tsx:1939`, `src/components/SummaryView.tsx:1949`, `src/components/SummaryView.tsx:1969`.

`cashSalaryExpense` và `cashRentExpense` đã là chi phí của kỳ ngày đang xem. Nhưng nhánh `filterType === 'day'` vẫn chia cả hai cho 30, kể cả khi chúng là phiếu chi thực của đúng ngày đó. Lương tháng đã chốt và phiếu chi ngày bị xử lý cùng một quy tắc.

**Tái hiện:** ngày có phiếu chi lương 300.000đ và mặt bằng 600.000đ; phần tài chính chỉ tính 10.000đ và 20.000đ.

**Sửa:** phân biệt báo cáo dòng tiền thực chi và báo cáo chi phí dồn tích/phân bổ. Khoản chi thực của ngày phải giữ nguyên. Chỉ phân bổ khoản thuộc cả tháng khi biết kỳ phân bổ và số ngày thực của tháng; gắn nhãn ước tính khi chưa đủ dữ liệu. Khi một phần nhân viên đã chốt lương, cần tổng hợp theo từng nhân viên/tháng, không dùng tổng bảng lương đã chốt để thay toàn bộ chi lương của kỳ.

### 9. P1 — Giá vốn ước tính có thể được công bố là đầy đủ

**Vị trí:** `src/components/SummaryView.tsx:1339`, `src/components/SummaryView.tsx:1516`; `scripts/backfill_daily_stats.ts:148`; đối chiếu `src/utils/costHelper.ts:41` và `src/App.tsx:4553`.

Checkout đã lưu `invoice.costStatus`. Nhưng báo cáo live/fallback tự đánh giá lại chỉ từ việc món có costPrice dương hoặc có recipe. Điều này bỏ qua trạng thái thiếu nguồn giá vốn của nguyên liệu/topping đã được checkout phát hiện. Backfill có cách đánh giá tương tự.

**Tái hiện:** một hóa đơn được lưu `costStatus: estimated`, `totalCost: 0`, có recipe nhưng nguyên liệu bị thiếu. Chính callback tổng hợp báo cáo trả `costStatus: complete`, `coverageStatus: reconciled`, giá vốn 0.

**Hậu quả:** lợi nhuận có thể bị thổi lên trong khi giao diện nói dữ liệu đầy đủ. Lỗi nhãn làm người dùng không biết cần đối soát.

**Sửa:** dùng snapshot `totalCost`, `costStatus`, `costVersion` làm nguồn chung. Thiếu nguyên liệu, thiếu topping hoặc giá vốn không hợp lệ phải giữ trạng thái thiếu/ước tính qua báo cáo và backfill. Không suy ra “đủ” chỉ vì có recipe. Lưu chi tiết các thành phần thiếu để sửa đúng nguồn.

### 10. P1 — Hủy hóa đơn có thể chưa cập nhật đúng lợi nhuận và báo cáo từ cache

**Vị trí:** `src/components/SummaryView.tsx:3203`; `src/components/TaxReportView.tsx:297`; `src/components/TaxReportView.tsx:129`.

Có hai đường sai khác nhau:

1. Sau hủy hóa đơn lịch sử, Summary sửa doanh thu/số hóa đơn trong state `dailyStats` nhưng không trừ `totalCost`. Xóa cache Map không tự làm effect tải lại nếu các dependency không đổi. Lợi nhuận có thể tiếp tục dùng giá vốn cũ trong state.
2. TaxReport gộp cache `yearInvoices` với live invoices theo cơ chế thêm/ghi đè ID. Khi hóa đơn đã bị xóa khỏi live, bản cũ trong yearInvoices vẫn còn. Các ngày đã covered cũng không tự tải lại chỉ vì hóa đơn bị hủy. Reconcile thêm dữ liệu chưa có ID nhưng không thay bản cũ hoặc xóa bản không còn.

**Tái hiện đường 2:** cache có hóa đơn 100.000đ đã hủy; live không còn hóa đơn này. Callback `effectiveInvoices` vẫn trả tổng 100.000đ. Lỗi ảnh hưởng ngày được tính từ hóa đơn fallback; với ngày dùng aggregate đối soát có thể chịu ảnh hưởng riêng từ cache aggregate cũ.

**Sửa:** invalidation thống nhất theo store/ngày sau mọi mutation; thay toàn bộ tập dữ liệu của ngày đã truy vấn đầy đủ, không chỉ union. Live của hôm nay phải thay thế phần hôm nay trong lịch sử khi nguồn live đủ. Sau hủy tải lại snapshot/aggregate hoặc hoàn nguyên đồng bộ toàn bộ trường từ dữ liệu giao dịch xác nhận, gồm giá vốn và mọi phương thức thanh toán.

### 11. P1 — Backfill có thể ghi đè kết quả hủy hóa đơn lịch sử

**Vị trí:** `scripts/backfill_daily_stats.ts:64` (đọc hóa đơn), `scripts/backfill_daily_stats.ts:312` (ghi đè stats); `api/migrate-store.ts:46`.

Backfill bỏ qua ngày hôm nay nhưng đọc nguồn và ghi aggregate lịch sử ở các thời điểm khác nhau. Khóa của API chỉ ngăn hai job migration; luồng hủy hóa đơn không kiểm tra khóa đó.

**Tái hiện:** job đọc hóa đơn lịch sử 100.000đ; máy khác hủy hóa đơn và đưa aggregate về 0; job ghi lại ảnh chụp cũ 100.000đ. Mô phỏng đúng khe thời gian đọc–ghi cho kết quả hóa đơn không còn nhưng stats vẫn có 100.000đ.

**Sửa:** mutation version theo ngày hoặc cơ chế khóa đối soát mà tất cả luồng ghi cùng tuân thủ. Chỉ công bố aggregate đã reconciled nếu nguồn chưa đổi trong lần tổng hợp; có thay đổi thì chạy lại. Ghi tổng hợp và cập nhật snapshot nguồn cần có tiến độ/trạng thái để khi job dở dang không công bố đã hoàn tất toàn bộ.

### 12. P1 — Luồng tải hiện tại bỏ sót khi dữ liệu cũ và mới cùng tồn tại

**Vị trí:** `src/App.tsx:2976`, `src/App.tsx:3041`; `src/components/SummaryView.tsx:903`, `src/components/SummaryView.tsx:991`.

Query modern theo businessDate/businessMonth/businessYear có ít nhất một kết quả thì dùng luôn; legacy chỉ được tải khi modern rỗng. Vì vậy, hóa đơn/phiếu thu cũ thiếu các trường business vẫn không được tính nếu trong cùng kỳ đã có một chứng từ modern.

Fallback trong App chỉ lấy 100 bản ghi; fallback an toàn của Summary chỉ quét 300 bản ghi toàn cửa hàng rồi lọc kỳ trên máy. Các giới hạn này không chứng minh đã tải đủ. Cursor của tập quét lọc trên máy còn bị dùng cho query legacy theo ngày, tức không còn cùng nguồn/thứ tự truy vấn. Có trường hợp lọc chỉ được dưới 50 chứng từ và `hasMore` bị đặt false dù còn chứng từ ngoài 300 bản ghi đã quét.

**Hậu quả:** thiếu doanh thu/thu chi hoặc xuất file gắn tên toàn kỳ nhưng chưa đầy đủ, ngay cả khi chứng từ còn nguyên trên server.

**Sửa:** hoàn tất migration có kiểm chứng số lượng trước khi chỉ dùng modern; trong giai đoạn chuyển tiếp, tải đủ hai nguồn và khử trùng theo document ID. Mọi fallback phải có phân trang và cờ độ đầy đủ rõ ràng. Cursor chỉ dùng lại cho đúng query đã tạo ra nó. Khi query lỗi, hiển thị lỗi/tạm thiếu; không coi mảng rỗng hoặc snapshot cache cục bộ là bằng chứng server không có dữ liệu.

### 13. P1 — Biểu mẫu thu chi/nhập/kiểm kho xóa nội dung trước khi biết lưu thành công

**Vị trí:** `src/components/SummaryView.tsx:2009`; `src/components/InventoryView.tsx:50`, `src/components/InventoryView.tsx:123`.

Các callback được khai báo kiểu trả void, gọi hàm async nhưng không await; modal đóng và reset ngay. Khi ghi bị từ chối hay lỗi, người dùng mất nội dung nhập và chưa có kết quả xác nhận đáng tin cậy. Với nhập/kiểm kho, có thể đã ghi được một phần như lỗi số 3.

**Sửa:** callback trả `Promise`/kết quả rõ ràng; await trong UI; khóa gửi lặp; giữ nội dung khi thất bại; chỉ đóng/reset khi đã xác nhận lưu. Khi offline cần phân biệt “đang chờ đồng bộ” và “server đã xác nhận”, kèm thao tác thử lại cùng operation ID.

## Các vấn đề bổ sung

### 14. P2 — Độ chính xác tồn kho không thống nhất và hoàn kho chưa dựa trên biến động đã chốt

**Vị trí:** `src/App.tsx:3496`, `src/App.tsx:3582`; đối chiếu checkout/hoàn kho làm tròn 3 chữ số tại `src/App.tsx:4382` và `src/App.tsx:4011`.

Nhập kho và state sau kiểm kho làm tròn 1 chữ số, nhưng xuất/hoàn kho dùng 3 chữ số. **Tái hiện:** tồn 0,95kg, nhập 0,1kg phải thành 1,05kg, mã hiện tại ghi 1,1kg. Giá vốn bình quân cũng dùng lượng tồn đã bị làm tròn.

Ngoài ra, hủy hóa đơn quyết định hoàn kho theo cờ trackStock hiện tại của nguyên liệu. Nếu khi bán không theo dõi tồn, sau đó bật theo dõi rồi hủy, có thể cộng kho dù lần bán không trừ. Chiều ngược lại có thể không hoàn phần đã trừ. Topping được tìm dự phòng theo tên cũng không bảo đảm đúng mặt hàng khi trùng tên.

**Sửa:** một chuẩn độ chính xác theo đơn vị; lưu movements thực tế theo invoice ID, gồm item ID và delta đã trừ; hoàn bằng đúng nghịch đảo movements đó. Không tái suy luận lịch sử từ danh mục/cờ hiện tại.

### 15. P2 — Aggregate tồn tại chưa có nghĩa là đã gồm hóa đơn đang hủy

**Vị trí:** `src/App.tsx:3932`, `src/App.tsx:4048`.

Hàm hủy chỉ kiểm tra document stats tồn tại rồi increment âm. Một stats cũ mới có chi phí, chưa từng bao gồm hóa đơn legacy, vẫn bị trừ doanh thu và số hóa đơn.

**Tái hiện:** stats chỉ có chi phí 50.000đ; hủy hóa đơn legacy 100.000đ làm document có doanh thu -100.000đ, số hóa đơn -1, giá vốn -40.000đ.

**Sửa:** kiểm soát mức bao phủ/phiên bản và liên kết nguồn. Stats chưa chứng minh gồm hóa đơn đó phải được đánh dấu cần đối soát/tính lại từ nguồn; không chỉ kẹp số âm về 0 vì sẽ che việc thiếu dữ liệu.

### 16. P2 — Số dư sổ quỹ chưa chắc là số dư thực của một két chung

**Vị trí:** `src/components/SummaryView.tsx:1748`; `src/App.tsx:2853`.

Tiền đầu ngày là tổng `startCash` của mọi ca đã tải. Nếu các ca dùng chung một két và bàn giao nối tiếp, tiền đầu ca sau có thể đã chứa tiền của ca trước; cộng các số đầu ca sẽ đếm trùng. Ngày cũ hơn phạm vi ca 3 ngày lại không được tải đủ nên đầu kỳ có thể thành 0. Với tháng/năm, openingCash luôn khởi tạo 0, chưa phải số dư chuyển kỳ.

**Sửa:** định nghĩa quỹ/két/tài khoản riêng và luồng bàn giao; số dư đầu kỳ là snapshot đã chốt hoặc số dư kế thừa từ kỳ trước. Nếu chỉ hiển thị phát sinh trong kỳ, đặt tên “thuần thu–chi trong kỳ”, không công bố đó là tồn quỹ thực tế.

### 17. P2 — Khách hàng ngoài 100 bản ghi nạp sẵn có thể không chọn được khi thanh toán

**Vị trí:** `src/App.tsx:2883`, `src/App.tsx:594`; `src/components/CustomerView.tsx:42`.

CRM có truy vấn từ xa theo đúng số điện thoại, nhưng dropdown thanh toán chỉ tìm trong 100 khách của state. Khách đã lưu nhưng nằm ngoài tập này có thể không tìm ra, không gắn được hóa đơn/ưu đãi theo hạng. Tìm theo tên ở CRM cũng chỉ đầy đủ trong tập đã nạp.

**Sửa:** dùng chung tìm kiếm server/phân trang cho CRM và chọn khách khi thanh toán, giữ đúng ID khách; có guard bỏ kết quả tìm kiếm cũ trả về muộn. Không tạo khách mới chỉ vì tìm trong cache không thấy.

### 18. P2 — Thống kê món bán chưa bao gồm toàn bộ tiền món kèm

**Vị trí:** `src/components/SummaryView.tsx:1237`.

Doanh thu món hiện là `item.price * quantity`, không gồm selectedAddOns, giảm giá phân bổ hoặc VAT. Nếu nhãn là “doanh thu món” để đối chiếu tổng hóa đơn, tổng này không khớp. Khi dữ liệu đang phân trang, xếp hạng món cũng chỉ phản ánh hóa đơn đã tải.

**Sửa:** định nghĩa rõ doanh thu trước thuế/sau giảm giá; phân bổ theo dòng hoặc tách món kèm thành dòng riêng. Chỉ công bố top món toàn kỳ sau khi đã tải đủ hoặc từ aggregate theo món có đối soát.

## Những phần đang làm đúng và nên giữ

- Thanh toán gộp hóa đơn, phiếu thu, kho, điểm khách, thống kê ngày và bàn trong một transaction.
- Với session đã lưu, checkout kiểm tra nội dung đơn trên server, phát hiện thay đổi và có khóa chống thanh toán lại cùng tập session.
- Phiếu thu bán hàng dùng ID liên kết `cash_${invoiceId}`; hủy có kiểm tra store và lưu audit thay vì mất toàn bộ dấu vết.
- Checkout lưu snapshot tổng giá vốn và trạng thái chất lượng; báo cáo cần dùng nhất quán các thông tin này.
- Helper ngày kinh doanh quy đổi giờ Việt Nam và dùng cận cuối mở cho truy vấn.
- Summary đã có cảnh báo dữ liệu chưa đủ; TaxReport đã có bước chặn xuất khi khoảng ngày chưa đối soát. Tuy vậy, nguồn dữ liệu/cờ đầy đủ vẫn cần sửa như các mục trên, cảnh báo không tự bảo đảm số liệu đúng.

## Kết quả 17 tình huống kiểm thử mức hàm

Các con số dưới đây là dữ liệu giả lập, không phải doanh thu hay số liệu của cửa hàng thật.

| Ca | Kỳ vọng | Kết quả mã hiện tại | Kết luận |
|---|---|---|---|
| Hai máy thêm món từ số lượng 1, thêm 1 và 2 | 4 suất | 3 suất | Tái hiện mất cập nhật |
| Bếp ghi trạng thái từ danh sách cũ sau khi có đơn mới | Giữ s1 và s2 | Chỉ còn s1 | Tái hiện mất đơn |
| Gộp bàn, ghi đích lỗi sau khi xóa nguồn | Giữ nguyên dữ liệu hoặc hoàn tất cả hai | Mất đơn nguồn | Tái hiện ghi dở |
| Tồn 10, hai lần nhập 5 và 7 cùng ảnh chụp | 22 | 17 | Tái hiện sai tồn |
| Nhập 5, lỗi ghi phiếu chi giữa quy trình | Toàn bộ hoặc không ghi | Tồn 15, có nhật ký, thiếu chi/thẻ kho | Tái hiện thiếu chứng từ |
| Tồn 0,95kg, nhập 0,1kg | 1,05kg | 1,1kg | Tái hiện sai làm tròn |
| Hủy hóa đơn tiền mặt 100.000đ | Ngày và ca cùng giảm | Ngày 0, ca còn 100.000đ | Tái hiện lệch ca |
| Thanh toán với state ca cũ, server đã đóng ca | Từ chối/đổi ca hợp lệ | Cộng 100.000đ vào ca đóng | Tái hiện sai đối soát |
| Thanh toán lại cùng session đã lưu | 1 hóa đơn | 1 hóa đơn | Ca đối chứng đúng |
| Đơn draft đã commit, lỗi đồng bộ hết hàng rồi bấm lại | 1 hóa đơn | 2 hóa đơn | Tái hiện ghi trùng |
| Recipe thiếu nguồn giá vốn ở helper checkout | isComplete=false | isComplete=false | Ca đối chứng đúng |
| Hóa đơn giá vốn estimated, có recipe thiếu nguyên liệu | Giữ nhãn estimated/thiếu | Báo complete | Tái hiện nhãn sai |
| Chi lương ngày 300.000đ, thuê ngày 600.000đ | Giữ 300.000đ và 600.000đ | 10.000đ và 20.000đ | Tái hiện sai chi phí |
| Hủy invoice legacy chưa có trong stats chi phí | Không tạo doanh thu âm giả | -100.000đ, invoiceCount=-1 | Tái hiện stats âm |
| Cache báo cáo còn hóa đơn đã xóa khỏi live | Không tính hóa đơn đó | Còn 100.000đ | Tái hiện dữ liệu cache cũ |
| 5 nhân viên × 30 ngày × 100.000đ, chỉ nạp 100/150 công | 15.000.000đ khi đủ | 10.000.000đ từ tập bị cắt | Tái hiện tính lương thiếu |
| Backfill đã đọc nguồn, hủy lịch sử trước khi job ghi | Stats 0 sau hủy | Stats lại thành 100.000đ | Tái hiện ghi đè đối soát |

## Thứ tự sửa đề xuất

1. Chặn mất/trùng giao dịch: cập nhật order/bếp; gộp/chuyển bàn; nhập/kiểm kho; ID ổn định cho draft và retry; UI chờ xác nhận lưu.
2. Đồng bộ sổ tiền: hoàn nguyên đúng ca khi hủy; kiểm tra ca mở trong mọi giao dịch; quy tắc điều chỉnh ca đóng.
3. Bảo đảm nguồn báo cáo đầy đủ: dữ liệu legacy/modern, phân trang, dữ liệu chấm công, invalidation sau mutation và version đối soát.
4. Sửa công thức/ý nghĩa hiển thị: chia chi phí ngày, cờ giá vốn, số dư đầu kỳ, doanh thu món, độ chính xác đơn vị kho.
5. Chạy kiểm thử với Firebase Emulator hoặc dự án dữ liệu thử, ít nhất hai thiết bị, mạng chập chờn/offline, chuyển ngày lúc 00:00 Việt Nam, hơn 100/300 chứng từ và hủy chứng từ lịch sử. Sau đó dùng nguyên pipeline đang chạy để kiểm tra iOS và Android.

Sửa logic mới không tự chữa dữ liệu cũ đã lệch. Sau sửa cần đối soát có backup theo ngày giữa hóa đơn, phiếu thu, ca, movements kho và aggregate; chạy dry-run trước. Đối soát kho phải dựa trên chứng từ biến động thực, không tự động suy ngược từ recipe/danh mục đã thay đổi.

## Cấu hình build được giữ nguyên

Đây là thông tin đọc từ bản 19, không phải đề xuất nâng/hạ phiên bản. Các khoảng semver là khai báo trong package.json, không phải xác nhận phiên bản thực đã cài trên runner.

| Thành phần | Cấu hình trong nguồn |
|---|---|
| iOS workflow | `.github/workflows/ios.yml` |
| Runner | `macos-15` |
| Xcode | `26.2` qua `maxim-lobanov/setup-xcode@v1` |
| Node trong workflow | `22.x`, cài bằng `npm ci` |
| Capacitor core / Android / CLI | `^8.3.0` |
| Capacitor iOS | `^8.5.0` |
| React / React DOM | `^19.0.0` |
| Firebase / Firebase Admin | `^12.10.0` / `^14.5.0` |
| TypeScript / Vite | `~5.8.2` / `^6.2.0` |
| iOS deployment target / Podfile | `15.0` |
| Android min / compile / target SDK | `24 / 36 / 36` |
| Gradle wrapper | `8.14.3` |
| Android Gradle Plugin | `8.13.0` |
| Kotlin Gradle Plugin | `2.0.21` |

Không áp dụng lại cấu hình của bản 17 hoặc nâng phiên bản theo hướng dẫn cũ vào bản đã chạy thành công này. Khi triển khai sửa, chỉ thay đổi phần logic cần thiết và xác minh các tệp build/phụ thuộc vẫn nguyên byte, trừ khi bạn yêu cầu riêng một thay đổi môi trường.
