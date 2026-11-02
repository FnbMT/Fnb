# Fnb Master — Đánh giá Firestore bản (4)

Ngày kiểm tra: 22/10/2026, giờ Việt Nam. Nguồn: `remix-fnb-master---pos (4).zip`, đối chiếu trực tiếp với source bản (3).

## 1. Nhận định

**Bản (4) giảm được phạm vi đọc rất đáng kể ở luồng chính. Tuy nhiên, chưa nên xem đây là bản đã hoàn tất tối ưu để phát hành rộng: có lỗi mới do cắt số dòng báo cáo, mất điều kiện phân vai trò và dùng sai cận cuối kỳ. Một số lỗi thống kê/cache cũ vẫn còn.**

Điểm cần làm tiếp không phải tăng hoặc giảm các con số `limit` tùy ý. Cần tách rõ dữ liệu tổng hợp đầy đủ với từng trang chứng từ, rồi thu hẹp listener theo đúng vai trò/màn hình.

Phạm vi kiểm tra: đối chiếu sáu file source thay đổi, rà soát các điểm đọc/ghi liên quan, rules/indexes/backfill và chạy 18 trường hợp kiểm tra cô lập trên đoạn source thực tế. Không truy cập Firebase production, không chạy backfill, không sửa source ứng dụng. Chưa chạy build/lint toàn dự án, SDK thật, emulator hay APK/IPA; các phép thử dùng Firestore giả lập bằng mock, không đo billable reads.

## 2. Những phần đã sửa đúng

| Hạng mục | Bản (3) | Bản (4) | Đánh giá |
|---|---|---|---|
| Listener invoices/cash hôm nay | Chỉ lọc storeId, lấy cả lịch sử | Lọc storeId và `date >= start`, `date < nextDay` trên server | Đã sửa đúng ở nhánh chính |
| Đổi ngày | Gắn lại toàn bộ listener root | Tách effect dữ liệu theo ngày | Đã cải thiện; menu/bàn/settings không bị gắn lại chỉ vì đổi ngày |
| Ngày thống kê checkout/hủy | Cắt ngày từ chuỗi UTC | Dùng ngày Việt Nam, lưu businessDate trong invoice | Đã sửa cho hóa đơn mới; dữ liệu cũ cần migration |
| Query chi tiết Tổng kết | Lấy toàn bộ lịch sử | Có date range, orderBy và limit | Giảm reads, nhưng giới hạn đang gây mất tính đầy đủ |
| TTL Summary | Hết hạn vẫn dùng entry cũ rồi gia hạn | Xóa entry hết hạn trước khi nạp lại | Đã sửa lỗi đóng băng cache |
| Thuế sau hủy bớt hóa đơn | Math.max giữ doanh thu cũ | Thay bằng tổng live khi còn ít nhất một hóa đơn | Đã sửa một phần; hủy hết vẫn sai |
| Gộp nguyên liệu | Đã gộp từ bản (3) | Giữ nguyên | Tiến bộ trước đó được giữ lại |

Vị trí chính: [App.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v4/src/App.tsx), dòng 2675, 2705, 2733, 3553, 3809, 3835; [firestoreDateHelper.ts](sandbox:/workspace/scratch/9a5780e43587/source-v4/src/utils/firestoreDateHelper.ts), dòng 10 và 42; [SummaryView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v4/src/components/SummaryView.tsx), dòng 199.

Kiểm tra hóa đơn lúc 06:30 ngày 22/10/2026 Việt Nam: ngày ghi stats nay là 22/10; tổng tháng cho mẫu một hóa đơn 100.000đ trả 100.000đ, không còn 200.000đ như bản (3).

## 3. P0: limit đang cắt dữ liệu nhưng giao diện vẫn tính tổng như dữ liệu đầy đủ

Nguồn: SummaryView, dòng 251–257, 285–291, 319–325.

| Tập dữ liệu | Giới hạn ở nhánh chính | Nơi vẫn dùng để tính/xuất toàn kỳ |
|---|---:|---|
| Invoices | 150 | Món bán chạy (407), xuất Excel hóa đơn (464), giá vốn mẫu (562), tổng doanh thu khi thiếu stats (559) |
| Cash transactions | 200 | Tổng thu/chi và số dư (424), chi phí vận hành (589), thẻ tiền mặt/chuyển khoản (628), xuất sổ quỹ (491) |
| Inventory logs | 150 | Tổng nhập/trả (624), danh sách và xuất kho (475) |

`paginate()` ở dòng 691 chỉ cắt mảng bằng `slice()`. Không có `startAfter` trong source ứng dụng để tải tiếp trang Firestore. Người dùng không thể lấy dòng thứ 151/201 qua việc bấm trang hiện tại nếu không có nguồn live khác bổ sung.

**Tái hiện với một tháng đã qua:** 201 hóa đơn tiền mặt × 100.000đ; mỗi hóa đơn có một món, một giao dịch quỹ; daily_stats có đủ 20.100.000đ.

| Kết quả | Đúng phải là | Code hiện trả |
|---|---:|---:|
| Doanh thu tổng hợp | 20.100.000đ | 20.100.000đ nếu stats đầy đủ |
| Thu tiền mặt | 20.100.000đ | **20.000.000đ** |
| Số suất món bán | 201 | **150** |
| Số hóa đơn có thể xuất từ tập đang tải | 201 | **150** |

Đây là lỗi có thể tái hiện ngay trên logic, không cần giả định Firestore đang lỗi. Trường hợp chọn kỳ hiện tại có thể nhận thêm hóa đơn/giao dịch hôm nay từ App, nên không khẳng định mọi màn hình luôn bị cắt đúng ở 150/200. Tuy nhiên, nguồn live đó không bù đầy đủ lịch sử tháng/năm.

**Lỗi chọn nguồn tiền mặt/chuyển khoản:** dòng 651 dùng `autoCashSalesInTx > 0 ? autoCashSalesInTx : invoiceCashSales`; dòng 673 tương tự. Chỉ cần tải được một phần giao dịch bán hàng là phần này được ưu tiên hơn stats đầy đủ. Thay Math.max bằng ternary chưa giải quyết được việc nguồn nào đã đủ dữ liệu.

**Cách sửa:**

1. Dùng stats đã xác nhận đầy đủ cho các tổng doanh thu và tiền bán theo phương thức.
2. Bổ sung tổng thu ngoài bán hàng, chi phí, giá vốn và chỉ tiêu kho cần thiết; cập nhật khi nghiệp vụ ghi/hủy phát sinh. Đừng lấy tổng toàn kỳ từ trang chứng từ đang xem.
3. Danh sách chi tiết dùng 20–50 document/trang, giữ snapshot cuối làm cursor; thêm `hasMore` và trạng thái đang tải.
4. Tìm kiếm hóa đơn phải có phạm vi rõ ràng. Lọc một trang local không được trình bày như tìm toàn bộ tháng.
5. Xuất đầy đủ là tác vụ riêng, đọc đủ các trang theo yêu cầu hoặc dùng job export có phạm vi; nếu chỉ xuất trang hiện tại thì đặt tên rõ.
6. Tổng theo món cần nguồn tổng hợp món riêng nếu dùng thường xuyên. Không cộng 150 hóa đơn mới nhất rồi gọi là tổng tháng.

Không sửa bằng cách tăng limit lên 5.000 hoặc bỏ limit khỏi dashboard; cách đó làm chi phí trở lại tăng theo số hóa đơn. Phân trang cũng không giảm tổng reads nếu một tác vụ chủ động đọc hết mọi trang để xuất toàn bộ dữ liệu.

## 4. P1 về reads: mất bộ lọc vai trò trong effect dữ liệu nền

App dòng 2517 vẫn khai báo `isKitchenOrOrder`, nhưng không sử dụng. Các nhánh return sớm cho bếp/order của bản (3) đã bị xóa khỏi effect này.

Do đó, máy bếp và order nay cũng nghe:

- Users của cả quán (2606).
- Tất cả ca đang mở của quán (2619), thay vì ca riêng của order.
- Ca đã đóng trong cửa sổ ba ngày (2634).
- Tối đa 100 khách hàng (2660).

Việc chặn invoices/cash ở effect theo ngày vẫn hoạt động, nhưng không chặn bốn nhóm dữ liệu phía trên.

| Vai trò | Listener root bản (3) | Listener root bản (4) |
|---|---:|---:|
| Admin / cashier / order_cashier | 12 | 12 |
| Order | 7 | **10** |
| Kitchen | 6 | **10** |

Đã kiểm tra bằng việc thực thi hai effect với mock listener. Đây là số subscription logic của App trước fallback, không phải số reads. Tuy nhiên, query mới làm tăng phạm vi tài liệu tải đầu và cập nhật liên tục: mỗi giao dịch checkout còn cập nhật ca mở, nên máy bếp/order bị đăng ký nhận thêm cập nhật doanh thu ca.

**Sửa:** khôi phục guard trước listener users/shifts/customers; order chỉ nghe ca của chính mình; bếp không nghe ca, users, customers trừ khi có chức năng cụ thể yêu cầu. Comment “chỉ thu ngân/quản lý” hiện không thực thi phân quyền hay giảm reads.

Ví dụ phạm vi tải đầu thêm cho một máy bếp: `số users + số ca mở + số ca đóng trong cửa sổ + min(số khách,100)` document, chưa tính cập nhật sau đó. Không quy đổi tỷ lệ tăng listener thành tỷ lệ tăng bill.

## 5. P1: fallback giới hạn nhỏ đang bị coi là dữ liệu toàn vẹn

### App: fallback 50 document

App dòng 2718 và 2745: khi query theo ngày lỗi, ứng dụng nghe 50 hóa đơn/giao dịch mới nhất, rồi lọc ngày trên client. Trong khi đó, Summary bỏ stats hôm nay và tính lại từ toàn bộ `invoices` nhận qua props.

Kiểm tra: hôm nay có 51 hóa đơn × 100.000đ, stats đúng 5.100.000đ. Kích hoạt nhánh fallback → live chỉ có 50 hóa đơn → tổng hôm nay thành **5.000.000đ**.

Fallback còn có `orderBy(date)` nên không bảo đảm sẽ chạy nếu chính index tương ứng chưa triển khai. Nó cũng được kích hoạt cho mọi lỗi, không riêng lỗi index. Không được dùng dữ liệu fallback này làm nguồn đối soát/chốt ca đầy đủ.

### Summary: bỏ date và orderBy trong fallback

Summary dòng 263, 297, 331 chỉ giữ storeId + limit. Những document nhận được theo thứ tự mặc định không nhất thiết thuộc kỳ đang xem. Lọc thời gian sau đó có thể cho mảng rỗng dù kỳ có dữ liệu, và mảng rỗng này được cache.

**Sửa:** triển khai/kiểm tra các index cần thiết, xử lý lỗi truy vấn có kiểm soát và giữ dữ liệu tốt cuối cùng kèm trạng thái chưa cập nhật. Nếu dùng fallback, phải giữ đúng phạm vi nghiệp vụ và thể hiện mức độ đầy đủ. Bổ sung trạng thái như `loading/complete/partial/error` cùng kỳ dữ liệu, không chỉ một mảng.

`firestore.indexes.json` đã có index storeId + date tăng/giảm cho invoices, cash_transactions, inventory_logs. File index không thay đổi từ bản (3). Không có quyền truy cập project nên chưa xác nhận chúng đã được deploy và ở trạng thái sẵn sàng. Không cần bỏ điều kiện ngày để “né” index.

## 6. P1: cận cuối kỳ đã đổi sang exclusive nhưng nơi sử dụng vẫn <=

Helper `getDateRangeIso` nay trả `endIso` là 00:00 đầu ngày/tháng/năm kế tiếp. Nhưng Summary vẫn dùng:

```ts
where('date', '<=', endIso)
inv.date <= endIso
```

Các vị trí: query dòng 255, 289, 323; fallback dòng 271, 305, 339; bộ lọc dòng 376, 393, 402, 631.

Hệ quả: hóa đơn đúng 00:00:00.000 đầu kỳ kế tiếp có thể nằm trong cả hai kỳ. Kiểm tra day/month/year đều xác nhận biên cuối được nhận sai. Đây là lỗi ở đúng thời điểm biên, không phải toàn bộ ngày kế tiếp bị lấy vào.

Đổi tên `endIso` thành `endExclusiveIso` và sử dụng `<` thống nhất ở query lẫn filter. Nhánh listener hôm nay của App đã dùng `<` đúng; không cần sửa lại thành `<=`.

## 7. Stats và cache: đã sửa một phần, còn thiếu tính đầy đủ và invalidation

### Stats có ít nhất một document chưa đủ chứng minh cả kỳ đã đầy đủ

Summary dòng 527 và 559 chỉ cần có stats là ưu tiên tổng stats. TaxReport dòng 56 cũng chỉ kiểm tra snapshot không rỗng rồi không tải lịch sử fallback.

Kiểm tra Summary với hóa đơn đã tải đủ 1.000.000đ nhưng stats mới chứa 100.000đ: tổng hiển thị **100.000đ**. Đây có thể xảy ra khi quán nâng cấp giữa kỳ và chưa hoàn tất backfill.

Cần metadata về phiên bản/ngày bắt đầu/ngày kết thúc đã tổng hợp và trạng thái hoàn tất. Hợp nhất dữ liệu theo từng khoảng được xác nhận; thiếu stats không tự đồng nghĩa không có doanh thu.

### Thuế: còn hai lỗi của bản trước

Nguồn: [TaxReportView.tsx](sandbox:/workspace/scratch/9a5780e43587/source-v4/src/components/TaxReportView.tsx).

1. Dòng 125 chỉ thay stats hôm nay khi `invoices.length > 0`. Sau hủy hết hóa đơn, stats cũ trong cache vẫn còn. Kiểm tra 200.000đ → hủy hết: vẫn **200.000đ**, thay vì 0. Cần cờ xác nhận live đã tải đủ, sau đó cho phép thay bằng 0.
2. Nếu chưa có stats năm, code tải hóa đơn theo khoảng fallback. Nhưng dòng synthetic hôm nay làm `mergedDailyStats` không rỗng, rồi công thức quý/ngày bỏ qua lịch sử đã tải. Kiểm tra 900.000đ lịch sử + 100.000đ hôm nay: quý chỉ trả **100.000đ**, thay vì 1.000.000đ.

Khi thay kỳ, cũng cần xóa/đổi nguồn state theo request phù hợp để stats của kỳ cũ không bị giữ khi kỳ mới không có stats. Những nguồn fallback và stats phải có trạng thái riêng.

### TTL đã đúng hơn nhưng chưa phải cơ chế đồng bộ báo cáo

Kiểm tra quay lại kỳ sau sáu phút: Summary nay phát ba query stats/invoices/cash, thay vì 0 query trên cache hết hạn như bản (3). Đây là sửa đúng, dù reads đo được có thể cao hơn bản cache lỗi.

TTL được kiểm tra khi effect chạy lại, không phải có bộ hẹn giờ cứ năm phút tự tải. Để màn hình đứng yên không bảo đảm dữ liệu lịch sử tự refresh sau đúng năm phút.

Handler hủy ở Summary dòng 1678–1687 chỉ dọn invoices/cash của kỳ hiện tại. Nó chưa giảm/xóa `dailyStats`, chưa vô hiệu hóa cache ngày/tháng/năm liên quan và `taxStatsCache`. Hủy hóa đơn quá khứ có thể làm danh sách mất hóa đơn nhưng tổng vẫn cũ. Thay đổi từ máy khác cũng cần cơ chế cập nhật/version phù hợp.

Cleanup hiện chỉ ngăn setState cuối cùng. Kiểm tra unmount ngay sau query đầu vẫn có ba query stats/invoices/cash được phát. Nên kiểm tra request còn cần sau từng await, trước khi bắt đầu query kế tiếp; dùng Promise cache để dùng chung request đang chạy. Request đã gửi không thể hoàn tác reads chỉ bằng biến `isMounted`.

## 8. Dữ liệu cũ và thao tác nhiều máy cần xử lý trước khi tin hoàn toàn vào stats

Sửa helper không tự sửa các document daily_stats đã ghi theo ngày UTC trước đó. Hủy một hóa đơn cũ nay giảm ngày Việt Nam; nếu dữ liệu vẫn nằm ở bucket UTC thì có thể giảm nhầm bucket hoặc thất bại. App dòng 3562 vẫn nuốt lỗi cập nhật stats.

[backfill_daily_stats.ts](sandbox:/workspace/scratch/9a5780e43587/source-v4/scripts/backfill_daily_stats.ts) không thay đổi: quét invoices toàn bộ quán (17), ghi đè các tổng (85), không có phạm vi/checkpoint/coverage/cutoff. Chạy lại không tự dọn các bucket sai ngày không còn hóa đơn. Nếu có thanh toán giữa lúc đọc và lúc ghi, tổng backfill cũ có thể đè increment mới.

Nên tái tạo thống kê theo phiên bản mới, quán/phạm vi rõ ràng, có đối soát và cơ chế bắt kịp các thay đổi phát sinh trong migration. Không chạy lại toàn hệ thống mỗi lần muốn sửa số báo cáo. Tôi không chạy script này.

Checkout vẫn dùng khóa Set local (App 3660), không chống được hai thiết bị thanh toán cùng đơn. Tồn kho ghi số tuyệt đối từ state cached (4000–4005), ca cũng cộng từ state (4024). Gộp nguyên liệu giảm writes nhưng không làm cập nhật tồn an toàn khi hai máy cùng bán. Hủy hóa đơn vẫn tách nhiều bước thay vì một nghiệp vụ nguyên tử.

Đây là vấn đề tính đúng đã tồn tại, không phải lỗi mới do date range. Cần transaction/idempotency theo nghiệp vụ và nguồn xác thực đáng tin trước khi bỏ kiểm tra từ chứng từ. Một transaction có thể tốn thêm reads cục bộ; điều đó vẫn hợp lý nếu tránh ghi trùng, mất tồn hoặc phải đọc lại lịch sử để sửa sai.

## 9. Cơ hội giảm reads còn lại sau khi sửa các lỗi trên

### Dashboard còn tải dữ liệu không cần hiển thị

Summary effect vẫn luôn lấy stats + invoices + cash dù đang xem chỉ tiêu tổng. Tab kho lấy thêm logs. App còn nghe logs và payroll mỗi khi view là summary, không phụ thuộc tab con.

Với kỳ tháng có 31 ngày và đủ dữ liệu, các query chính có thể trả `31 + 150 + 200 = 381` document trong một lượt nạp, trước logs/payroll và listener root. Đây là lượng kết quả query trong giả định, không phải phép đo bill và không khẳng định mọi lời gọi SDK đều tạo một lượt tính phí riêng.

Mục tiêu kiến trúc:

| Nhu cầu | Dữ liệu nên lấy |
|---|---|
| Chủ quán xem hôm nay | Stats hôm nay + cảnh báo chưa xử lý thật sự cần realtime |
| Biểu đồ doanh thu tháng | Daily stats đúng tháng, tối đa 28–31 document nếu một doc/ngày |
| Hóa đơn chi tiết | 20–50 document/trang theo kỳ, cursor |
| Sổ quỹ chi tiết | 20–50 document/trang; tổng toàn kỳ lấy từ nguồn riêng đầy đủ |
| Món bán chạy | Tổng hợp theo món/kỳ hoặc tác vụ đọc chi tiết có chủ đích |
| Bếp | Bàn/đơn cần xử lý, menu/settings cần thiết; không users/khách/ca |
| Order | Dữ liệu gọi món và ca của chính mình |

Tổng hợp ghi sẵn phù hợp báo cáo realtime; tổng hợp lúc đọc (`count/sum/average`) có thể cân nhắc cho báo cáo ít xem và không cần realtime. Không có phương án nào tự miễn phí; chọn dựa trên số lần đọc và số lần nghiệp vụ thay đổi.

### Những phần chưa thay đổi từ bản (3)

- Mọi vai trò nghe menu, mỗi thanh toán cập nhật stock trên menu → phát thay đổi tồn tới các máy không cần số tồn chi tiết. Tách danh mục khỏi số dư kho; trạng thái khả dụng chỉ phát khi cần.
- Lương cá nhân vẫn tải tới 300 attendance toàn quán; kho lấy 100 stock card mọi nguyên liệu. Cần filter người/tháng hoặc item/thời gian trước limit.
- Số dư đầu kỳ vẫn lấy từ ca hoặc 0, chưa có checkpoint quỹ tin cậy cho tháng/năm. Không chữa bằng tải toàn bộ lịch sử.
- Giá vốn/lợi nhuận vẫn có nhánh ước lượng từ mẫu hóa đơn, mặc định tỷ lệ 35% khi không có mẫu. Limit 150 khiến mẫu dễ lệch cơ cấu món. Cần lưu giá vốn đầy đủ vào aggregate hoặc thể hiện rõ đây là ước tính.
- Tìm khách vẫn query khi từ khóa từ ba ký tự sau debounce; Superadmin/export/backfill còn có tác vụ quét rộng. Đây là nhóm ưu tiên sau query vận hành chính.
- Rules/API không đổi. [firestore.rules](sandbox:/workspace/scratch/9a5780e43587/source-v4/firestore.rules) vẫn cho đọc/ghi công khai phần lớn collection. Nếu đây là cấu hình production, chi phí và dữ liệu vẫn chưa được bảo vệ theo quán/role. Chưa có bằng chứng quota đang bị lạm dụng; cần hoàn thiện Auth/API trước khi triển khai rules chặt.

## 10. Thứ tự sửa đề xuất và tiêu chí nghiệm thu

| Ưu tiên | Công việc | Kiểm tra đạt yêu cầu |
|---|---|---|
| 1 | Tách tổng hợp đầy đủ khỏi trang chi tiết; sửa nguồn tiền mặt/chuyển khoản | 201 hóa đơn: tổng 20,1 triệu, món 201 suất; tải đủ trang/export đủ khi yêu cầu |
| 2 | Khôi phục guard bếp/order | Bếp không đăng ký users/khách/ca; order chỉ ca riêng |
| 3 | Thống nhất cận cuối exclusive và bỏ fallback làm sai phạm vi | 00:00 chỉ thuộc kỳ mới; query lỗi không biến thành báo cáo thiếu mà không cảnh báo |
| 4 | Stats coverage + live readiness + invalidation | Hủy hết về 0; nâng cấp giữa năm không mất lịch sử; hủy kỳ cũ cập nhật tổng |
| 5 | Migration stats cũ và giao dịch nhiều máy | Bucket Việt Nam đúng; không ghi trùng đơn/mất tồn/ghi đè backfill |
| 6 | Chỉ đọc chi tiết theo tab, cursor 20–50 dòng | Dashboard không tự gọi query chi tiết không cần thiết |
| 7 | Tách menu/tồn, thu hẹp kho/lương/quản trị; Auth/rules | Đọc theo nghiệp vụ, giới hạn được truy cập giữa quán |

Các lỗi quyền và tính đúng thanh toán phải xử lý trước phát hành rộng; thứ tự ở đây phản ánh trọng tâm review reads, không phải trì hoãn bảo vệ production.

## 11. Bằng chứng kiểm tra và giới hạn đánh giá

18 trường hợp đã chạy bằng Node, lấy các đoạn TypeScript trực tiếp từ bản (4):

| Nhóm thử | Số trường hợp | Kết quả |
|---|---:|---|
| Listener năm vai trò | 5 | Admin/cashier/order_cashier 12; order/kitchen 10; range hôm nay đúng |
| Hóa đơn 06:30 và tổng tháng | 1 | Đã sửa |
| Limit invoices/cash/logs | 1 | 201 mỗi loại → 150/200/150 |
| Thẻ tiền mặt | 1 | 20,1 triệu → 20 triệu |
| Tổng món và nguồn export | 1 | 201 → 150 |
| Cache quá sáu phút | 1 | Nạp lại ba query, đã sửa |
| Cleanup request | 1 | Vẫn phát query tiếp theo |
| Biên ngày/tháng/năm | 1 | Cả ba loại đều nhận sai timestamp đúng đầu kỳ kế tiếp |
| Fallback Summary | 1 | Bỏ điều kiện ngày và thứ tự |
| Stats thiếu so với hóa đơn | 1 | 1 triệu → 100 nghìn |
| Thuế hủy bớt | 1 | 200 nghìn → 100 nghìn, đã sửa |
| Thuế hủy hết | 1 | Còn giữ 200 nghìn thay vì 0 |
| Thuế fallback lịch sử | 1 | 1 triệu → 100 nghìn |
| App fallback 50 hóa đơn | 1 | 51 hóa đơn → 50; thiếu 100 nghìn trong mẫu |

Các số tiền trên là fixture kiểm tra, không phải dữ liệu quán thật. Mock query không xác nhận index đã deploy, SDK caching, retry hoặc charge của Firebase.

Sáu file source khác bản (3): App, SummaryView, TaxReportView, firestoreDateHelper, types, MenuMgmtView. Thay đổi MenuMgmtView chủ yếu là nút giao diện nhóm món, không thay query Firestore. Rules, indexes, backfill và các API xác thực được đối chiếu không đổi.

Bundle public JS đóng gói sẵn trong Android/iOS không đổi so với bản (3). Tuy nhiên workflow iOS có `npm run build` và `npx cap sync ios`, nên không thể suy ra bản TestFlight vẫn cũ chỉ từ ZIP. Khi đo hiệu quả, xác nhận build ID thực tế và index đã sẵn sàng.

Đo sau sửa theo từng quán/role/màn hình: lượt mở mới, phiên ổn định và kết nối lại; ghi số document trả về, nguồn cache/server, attach/detach và đối chiếu Usage/Billing. Không cộng `snapshot.size` của mọi callback để coi là reads tính tiền, không ghi log mỗi read vào chính Firestore.

Theo tài liệu Firebase, free tier 50.000 document reads/ngày áp dụng cho một database đủ điều kiện trong project, không cấp thêm 50.000 cho mỗi quán dùng chung database. Listener tính reads theo document thêm/cập nhật và có quy tắc kết nối lại. Mục tiêu thương mại nên là chi phí/quán có thể dự báo, thay vì kỳ vọng hạn mức miễn phí tăng cùng số quán.

Nguồn kỹ thuật chính thức: [Billing](https://firebase.google.com/docs/firestore/pricing), [Cursor pagination](https://firebase.google.com/docs/firestore/query-data/query-cursors), [Aggregation](https://firebase.google.com/docs/firestore/solutions/aggregation).

**Kết luận: bản (4) đã xử lý được việc tải toàn lịch sử ở nhánh chính. Việc cần sửa ngay là giới hạn chi tiết làm sai báo cáo, listener bếp/order bị mở rộng và tính đầy đủ của stats. Sau đó mới có thể tiếp tục giảm reads mà vẫn giữ được báo cáo đáng tin.**
