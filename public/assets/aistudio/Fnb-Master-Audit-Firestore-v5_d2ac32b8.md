## 4. P0 về reads — Hôm nay rỗng lại đọc toàn bộ lịch sử

Nguồn: [App.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v5/src/App.tsx).

| Tình huống | Vị trí | Query phát sinh |
|---|---:|---|
| Listener invoices hôm nay trả rỗng | 2739–2742 | Invoices chỉ lọc storeId, không limit/date |
| Listener cash hôm nay trả rỗng | 2779–2781 | Cash transactions chỉ lọc storeId, không limit/date |
| Query invoices chính lỗi | 2755–2764 | Gắn listener toàn bộ invoices của quán |
| Query cash chính lỗi | 2794–2803 | Gắn listener toàn bộ cash của quán |

Hôm nay chưa có giao dịch là trạng thái bình thường, nhất là trước hóa đơn đầu tiên hoặc sau khi hủy hết. Nó không chứng minh cần đọc lại lịch sử. Snapshot cache ban đầu rỗng cũng có thể kích hoạt nhánh này trước khi kết quả server đến; code không kiểm tra trạng thái nguồn snapshot.

**Kiểm tra:** database mock có 9.000 invoices và 9.000 cash lịch sử, hôm nay 0. Hai callback rỗng phát hai query lấy tổng cộng **18.000 document**, cuối cùng UI vẫn hiển thị 0 hôm nay.

Nếu ba quán, mỗi quán có dữ liệu như mẫu và một máy phải lấy đầy đủ hai query từ server, riêng các kết quả này tương ứng khoảng 54.000 document. Đây là mô hình tải đầy đủ có điều kiện, không phải số đo billing; cache, SDK và kết nối ảnh hưởng lượt bị tính phí. Không nhân toàn bộ snapshot cho mọi callback cập nhật.

Fallback `.then()` cũng thiếu guard theo request/ngày/phiên. Kiểm tra request fallback bắt đầu từ snapshot rỗng, sau đó listener đã nhận một hóa đơn mới; khi fallback cũ trả rỗng muộn hơn, nó ghi đè state mới thành `[]`.

**Sửa:** giữ query ngày có phạm vi trên server và chấp nhận kết quả rỗng. Khi cần hỗ trợ dữ liệu cũ, query theo trường `date` đang có với cận ngày và index đã cấu hình. Không dùng query chỉ storeId làm fallback trong luồng vận hành. Kiểm tra request còn thuộc phiên/ngày hiện tại trước khi áp dụng kết quả bất đồng bộ.

## 5. P0 về dữ liệu — Đổi schema query nhưng chưa migrate dữ liệu cũ

App nay query `businessDate`; Summary query `businessDate/businessMonth/businessYear`. Các bản trước không ghi đủ ba trường này. Script backfill hiện chỉ tạo daily_stats từ invoices; không thêm businessMonth/businessYear vào hóa đơn, cũng không migrate cash_transactions.

### Hôm nay có cả hóa đơn cũ và mới

App chỉ chạy legacy fallback khi query mới trả rỗng. Nếu có một hóa đơn mới với businessDate, các hóa đơn cũ thiếu trường này sẽ không được lấy bổ sung.

Kiểm tra: hai hóa đơn legacy và một hóa đơn mới cùng ngày, mỗi hóa đơn 100.000đ → live chỉ có hóa đơn mới, tổng **100.000đ thay vì 300.000đ**, không chạy fallback. Sổ quỹ có cùng cấu trúc rủi ro.

### Xem tháng/năm cũ

Summary dòng 379–389 và 431–441. Hóa đơn bản (4) có businessDate nhưng chưa có businessMonth/businessYear. Query tháng trả rỗng hợp lệ, không ném lỗi, nên nhánh catch fallback không chạy.

Kiểm tra một hóa đơn bản (4) đúng tháng: database có 1, query bản (5) trả 0. Có thể thấy stats có doanh thu nhưng danh sách hóa đơn tháng trống.

**Phương án ít thay đổi và tương thích:** tiếp tục query `date >= startIso` và `date < endExclusiveIso` cho cả dữ liệu cũ/mới; dùng businessDate làm metadata thống nhất. Chỉ chuyển sang query trường mới sau khi migration hoàn thành, có version/coverage và kiểm tra tất cả đường ghi, bao gồm app cũ còn hoạt động.

Migration không nên chạy trong mỗi phiên client hay mỗi lần query rỗng. Cần job có phạm vi, checkpoint, đối soát và kế hoạch xử lý ghi đồng thời.

## 6. P1 — Có hàm cursor nhưng luồng tải đầu chưa dùng phân trang

Nguồn: [SummaryView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v5/src/components/SummaryView.tsx).

`handleLoadMoreInvoices` dòng 246 có `startAfter` và `limit(30)`. Nhưng lượt tải đầu dòng 372–395:

- Không có limit.
- Không có orderBy trong query, sắp xếp sau khi tải.
- Không lưu `currentEntry.lastInvoiceDoc`.
- Không đặt `currentEntry.hasMoreInvoices`.

Hai biến này chỉ được đặt trong chính hàm load-more. Do đó, trạng thái ban đầu giữ cursor null/hasMore false, nút tải thêm không xuất hiện. Đây là luồng chưa được nối hoàn chỉnh, không phải phân trang Firestore đã hoạt động.

**Kiểm tra tháng có 3.000 hóa đơn mới đủ field:** lần đầu tải **3.000**, `hasMore=false`, `lastCursor=null`.

Sổ quỹ cũng lấy toàn kỳ không limit. Xem năm có thể đọc hàng chục nghìn document; các fallback Summary còn bỏ phạm vi kỳ để quét toàn lịch sử của quán.

**Sửa:** trang đầu và trang sau phải cùng bộ where + orderBy, trang đầu limit 30, lưu snapshot cuối, xác định hasMore. Khi đổi kỳ, reset đúng cursor và ngăn response kỳ cũ cập nhật state kỳ mới. Cash cần cursor riêng. Không dùng một trang invoices để tính tổng món toàn kỳ; phần tổng món cần aggregate riêng hoặc tác vụ đọc đủ có chủ đích.

Lazy-load chi tiết dòng 195/218 hiện thường không giảm reads: query danh sách vẫn lấy nguyên document invoice, có sẵn items. Nếu items đã có thì đúng là không getDoc thêm; nếu items rỗng, getDoc lại cùng document chỉ thêm lượt đọc, không tự tạo cơ chế tách header/detail. Muốn giảm payload cần thay cấu trúc lưu trữ có cân nhắc, và payload nhỏ không tự đồng nghĩa giảm số document reads.

## 7. P0 về báo cáo — Lợi nhuận thay đổi theo thứ tự mở tab

Tải theo tab là hướng tốt, nhưng công thức còn phụ thuộc những mảng chưa tải:

- Tab financial chỉ tải daily_stats (Summary 312, 366, 419).
- Giá vốn dùng `filteredInvoices`, thiếu mẫu thì mặc định 35% (790–800).
- Chi phí vận hành dùng `renderedCashTransactions` (817).
- Thẻ tiền mặt/chuyển khoản vẫn lấy chi và thu ngoài bán hàng từ `allCashTransactions` (856).

**Mẫu kiểm tra tháng đã qua:** doanh thu 1.000.000đ; giá vốn thật 700.000đ; tiền điện 200.000đ; không lương/thuê nhà. Lợi nhuận đúng 100.000đ.

| Thao tác trong cùng phiên | Lợi nhuận code trả | Vì sao |
|---|---:|---|
| Mở trực tiếp financial cho kỳ đó | **650.000đ** | Chưa có invoices/cash; dùng vốn 35%, bỏ chi điện |
| Mở cash, quay lại financial | **450.000đ** | Có chi điện nhưng vẫn dùng vốn 35% |
| Mở sales rồi quay lại financial | **100.000đ** | Đã có giá vốn từ hóa đơn và chi từ sổ quỹ |

Trước khi xem cash, thẻ chi tiền mặt của mẫu cũng là 0 thay vì 200.000đ. Việc mở thẳng kỳ cũ ở tab financial là luồng hợp lệ khi người dùng đang ở financial rồi đổi bộ lọc tháng.

App có thêm ghi `totalIncome`, `totalExpense`, `cashCount` vào daily_stats ở dòng 3456, nhưng các công thức Summary không đọc những trường này; interface DailyStats cũng chưa mô tả chúng. Chưa có giá vốn tổng hợp và thu/chi tách theo phương thức/hạng mục. Vì vậy đã tăng writes mà chưa dùng để loại bỏ việc phụ thuộc chi tiết.

**Sửa:** xây hợp đồng dữ liệu aggregate đầy đủ cho đúng các chỉ tiêu đang hiển thị: doanh thu, giá vốn, thu ngoài bán hàng theo phương thức, chi theo phương thức/hạng mục, số dư đầu kỳ có ý nghĩa. Cập nhật nhất quán khi bán, nhập, trả, thu/chi, điều chỉnh/hủy. Chỉ render số tổng khi nguồn đó đủ; nếu phải ước tính thì ghi rõ ước tính. Không chữa bằng tự tải toàn bộ invoices/cash cho mọi tab.

## 8. Stats vẫn thiếu coverage và khả năng phân biệt rỗng với chưa tải

### Document chỉ chứa thu/chi cũng bị xem là đã có doanh thu tổng hợp

App `handleAddCashTransaction` có thể tạo stats chỉ có totalIncome/totalExpense/cashCount. Summary vẫn đặt `hasData=true` cho mọi stats row (dòng 643), rồi không dùng fallback invoices (659). Tax cũng chỉ kiểm tra stats snapshot không rỗng.

Kiểm tra stats chỉ có chi 200.000đ, hóa đơn legacy đã tải có doanh thu 1.000.000đ: Summary trả **doanh thu 0**. Có document stats không chứng minh chỉ tiêu bán hàng đã được backfill.

Cần version/coverage theo chỉ tiêu hoặc schema đủ và quy trình migration xác nhận hoàn tất. Không coi missing field luôn là số 0 hợp lệ.

### Summary hủy hết từ máy khác còn giữ stats cũ

Summary dòng 638 và 647 chỉ thay phần hôm nay bằng live khi `invoices.length > 0`. Nếu máy khác hủy hết hóa đơn trong khi stats đang cache 200.000đ, live rỗng nhưng Summary vẫn cộng **200.000đ**. Handler hủy tại chính Summary đã giảm stats local nên đã cải thiện đường thao tác đó; chưa giải quyết đường cập nhật từ máy khác.

Tax nay luôn thay hôm nay bằng live, kể cả rỗng, nên sửa tình huống hủy hết khi live đã xác nhận đầy đủ. Tuy nhiên, chưa có cờ readiness: `[]` lúc mới khởi tạo/query lỗi cũng có thể ghi đè doanh thu stats thật bằng 0.

Cần trạng thái live gồm kỳ, nguồn, trạng thái loading/complete/error và dữ liệu. Chỉ thay stats khi live của đúng ngày đã tải đủ. Dữ liệu rỗng hoàn tất phải khác dữ liệu chưa tải.

### Thu/chi và stats mới ghi tách rời

App dòng 3446 await addDoc cash; dòng 3456 gọi setDoc stats riêng, không await, lỗi chỉ console.warn. Nếu cash ghi thành công nhưng stats thất bại, nghiệp vụ vẫn có thể hoàn tất với aggregate thiếu. Cần batch/transaction thích hợp cùng idempotency theo nghiệp vụ; không chỉ thêm một write rồi mặc định stats luôn đúng.

## 9. Báo cáo thuế sửa công thức quý nhưng chưa sửa bảng theo ngày

Nguồn: [TaxReportView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v5/src/components/TaxReportView.tsx).

Các quý dùng `hasDailyStatsDb` từ dòng 143, đã sửa trường hợp chỉ có dòng synthetic hôm nay làm mất lịch sử. Nhưng bảng dailyData dòng 230 vẫn dùng `mergedDailyStats.length > 0` như cũ.

Kiểm tra chưa có stats DB, đã tải 900.000đ hóa đơn cũ và 100.000đ hôm nay:

- Tổng quý: **1.000.000đ**, đã đúng trong mẫu.
- Tổng bảng ngày: **100.000đ**, vẫn thiếu lịch sử.

Vì luôn thêm dòng hôm nay kể cả 0, bảng ngày của năm hiện tại còn có thể bỏ lịch sử khi hôm nay không bán. Cần áp dụng cơ chế chọn nguồn thống nhất cho quý/năm/ngày và có coverage, không chỉ sửa một nhóm công thức.

Ngoài ra, fallback năm không có stats chỉ đọc khoảng fromDate/toDate nhưng các thẻ quý/năm vẫn tổng hợp từ tập này. Nó không đảm bảo tổng năm nếu khoảng đang chọn chỉ là một tháng. Query stats trả một phần năm cũng chưa được phân biệt với stats đầy đủ.

## 10. Kho và cache còn các lỗi giới hạn/state

### Kho vẫn bị cắt ở 50 dòng

Summary dòng 482 giới hạn 50 logs; tổng nhập/trả dòng 852 và export dòng 744 vẫn cộng/xuất mảng này. Không có cursor logs.

Kiểm tra 51 lần nhập × 100.000đ trong kỳ cũ, khi không có nguồn live bổ sung: chỉ tải 50, tổng 5.000.000đ thay vì 5.100.000đ. Nguồn root 50 logs gần nhất toàn quán không bảo đảm bù phần thiếu của kỳ đang chọn.

### Kết quả rỗng không xóa state cũ

Summary dòng 514–516 chỉ setHistorical khi loaded.length > 0. Khi reload thành công với 0 document, state cũ có thể vẫn tồn tại. Kiểm tra reload cùng kỳ sau khi hóa đơn đã bị xóa: server trả 0 nhưng state còn 1 hóa đơn. Cache lại ghi invoices=[]; state/cache tạm mâu thuẫn.

Luôn cập nhật state đúng kết quả thành công, kể cả []; phân biệt chưa tải tab với đã tải tab nhưng rỗng. Khi đổi store/kỳ cần state có key hoặc reset rõ ràng.

### Cache/in-flight

TTL hết hạn vẫn hoạt động khi effect chạy lại. Tuy nhiên cleanup vẫn không ngăn query tiếp theo khởi động sau await; thiếu cache Promise đang chạy. Clear toàn bộ Summary cache sau hủy đã tốt hơn giữ số cũ, nhưng sẽ làm nạp lại các kỳ không liên quan và không xóa cache riêng của thuế. Nên invalidation đúng ngày/tháng/năm và chia sẻ cơ chế version giữa các báo cáo.

## 11. Những vấn đề cũ vẫn còn, cần đưa vào kế hoạch hoàn thiện

- Checkout vẫn khóa bằng Set local, không chống hai máy thanh toán cùng đơn; ghi tồn và tổng ca từ state cached có thể ghi đè nhau. Đây là rủi ro tính đúng khi thương mại nhiều thiết bị.
- Hủy invoice/cash/điểm/tồn/stats là nhiều bước riêng; cập nhật stats vẫn nuốt lỗi. Handler cha bắt lỗi nhưng không trả thất bại rõ cho Summary, nên UI có thể cập nhật giảm số dù thao tác backend chưa hoàn tất.
- Backfill không đổi: quét invoices toàn bộ quán, ghi đè tổng, chưa có cutoff/checkpoint/coverage, chưa dọn bucket UTC sai hoặc migrate field mới. Không chạy lại tùy tiện khi quán đang bán.
- Menu vẫn chứa stock và mọi máy nghe menu. Gộp nguyên liệu giúp giảm writes nhưng chưa giảm fan-out tồn kho tới các vai trò không cần.
- App vẫn nghe logs/payroll khi mở Summary dù tab con không cần. Lương cá nhân/kho vẫn lấy tập của cả quán rồi lọc người/item.
- Số dư đầu kỳ vẫn lấy startCash của ca hoặc 0 cho tháng/năm; cần checkpoint sổ quỹ hợp lý.
- Superadmin/export có query toàn collection. Cần phân trang/phạm vi và đo riêng tác vụ quản trị.

Tám file thay đổi: App, SummaryView, TaxReportView, types, firestoreDateHelper, save-user, register-store, change-password. Rules, indexes, backfill, Admin adapter và server routes không đổi từ bản (4).

## 12. Kế hoạch sửa cụ thể, tránh quay lại vòng tăng limit rồi bỏ limit

| Thứ tự | Thay đổi | Điều kiện nghiệm thu |
|---|---|---|
| 1 | Gỡ lưu password chữ rõ; xác minh token/tenant/role; sửa rules phù hợp | Request không xác thực bị từ chối; client không đọc được dữ liệu bí mật |
| 2 | Bỏ full-store fallback; query date range hỗ trợ dữ liệu cũ | Hôm nay rỗng không query lịch sử; hai bill cũ + một bill mới vẫn đủ ba |
| 3 | Nối trang đầu với cursor, cùng query/order | Tháng 3.000 hóa đơn chỉ tải trang đầu 30; tải tiếp không trùng/mất dòng |
| 4 | Hoàn thiện aggregate tài chính và coverage | Lợi nhuận không phụ thuộc thứ tự tab; stats thiếu không bị coi là số 0 đầy đủ |
| 5 | Live readiness, invalidation và bảng thuế ngày | Hủy hết về 0 sau dữ liệu hoàn tất; quý/ngày/năm thống nhất cùng phạm vi |
| 6 | Tổng kho riêng, cursor logs, xử lý empty state | 51 log tính đủ tổng; server rỗng thì UI rỗng |
| 7 | Migration và giao dịch nhiều máy | Không trùng thanh toán, không mất tồn, backfill không đè giao dịch mới |
| 8 | Giảm listener nền/menu stock và tác vụ quản trị | Reads theo đúng role/màn hình; có số đo theo quán/ngày |

Khi sửa cursor, cấu trúc khuyến nghị cho query chi tiết là cùng cận thời gian đã chuẩn hóa, cùng thứ tự date, và dùng document snapshot cuối để lấy trang tiếp. Tổng toàn kỳ lấy từ aggregate đầy đủ; export đủ dữ liệu là tác vụ chủ động riêng. Không dùng 30 chứng từ làm tổng tháng và không tải hết tháng chỉ để hiển thị 10 dòng đầu.

## 13. Kết quả 22 trường hợp kiểm tra

| Nhóm | Số ca | Kết quả |
|---|---:|---|
| Root năm vai trò | 5 | 12/12/12/7/6, khôi phục đúng |
| Hôm nay rỗng | 1 | Hai query toàn quán, 18.000 document trong mẫu |
| Dữ liệu legacy + mới cùng ngày | 1 | 300.000đ → 100.000đ |
| Fallback trả muộn | 1 | State một hóa đơn bị ghi đè thành rỗng |
| Summary hôm nay | 1 | Chỉ query stats trong effect này |
| Lịch sử 3.000 hóa đơn | 1 | Tải hết, cursor null, hasMore false |
| Hóa đơn bản (4) thiếu businessMonth | 1 | Có 1, query tháng trả 0 |
| Tài chính theo thứ tự tab | 1 | 650.000đ → 450.000đ → 100.000đ |
| Stats chỉ có chi | 1 | Doanh thu thật mẫu 1 triệu → 0 |
| Summary hủy hết từ máy khác | 1 | Giữ stats cũ 200.000đ |
| Kho 51 logs | 1 | Chỉ tải 50 |
| Reload thành công trả rỗng | 1 | State cũ còn một hóa đơn |
| Cache hết hạn | 1 | Nạp lại đúng các query cần theo tab |
| Cleanup query | 1 | Vẫn chạy tiếp invoices sau stats |
| Biên ngày/tháng/năm | 1 | Cả ba đã đúng |
| Thuế live rỗng | 1 | Thay bằng 0, cần readiness |
| Thuế quý so với bảng ngày | 1 | Quý 1 triệu, bảng ngày 100 nghìn |
| API đổi mật khẩu mock không có caller | 1 | HTTP 200 và ghi password chữ rõ |

Các phép thử lấy source block thật, mock thao tác DB, chạy với timezone Việt Nam. Đây không phải bộ kiểm thử end-to-end hay chứng nhận an toàn toàn ứng dụng. Không có số liệu reads thực tế theo tài khoản Firebase trong phiên kiểm tra.

Bundle JS public Android/iOS trong ZIP không đổi so với bản (4). Workflow iOS có build và Capacitor sync nên không thể kết luận bản phát hành vẫn cũ chỉ dựa vào ZIP; khi đo reads cần xác nhận đúng build đang chạy.

Theo tài liệu Firebase, đọc được tính theo document và có các quy tắc riêng cho listener/cache/kết nối lại; số callback hoặc số lời gọi SDK không tự bằng số reads tính phí. Free tier 50.000 reads/ngày dùng chung cho database đủ điều kiện trong project, không tăng theo số quán. Mục tiêu nên là chi phí/quán có thể dự báo, cùng tính đúng số liệu.

Nguồn chính thức: [Firestore billing](https://firebase.google.com/docs/firestore/pricing), [Cursor pagination](https://firebase.google.com/docs/firestore/query-data/query-cursors), [Quyền đọc theo document và trường dữ liệu](https://firebase.google.com/docs/firestore/security/rules-fields).
