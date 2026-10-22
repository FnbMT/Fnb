# Tối Ưu Hóa Chi Phí & Lượt Đọc Firestore — Fnb Master

Kế hoạch tối ưu triệt để lượt đọc/ghi Cloud Firestore nhằm đưa chi phí vận hành của 2 quán Fnb Master về mức an toàn trong gói miễn phí 50.000 Reads/ngày của Firebase.

### User Review & Critical Decisions

> [!IMPORTANT]
> Dựa trên phản hồi trực tiếp của bạn ở bước trước, kế hoạch này đã thống nhất 3 quyết định then chốt:
> - **Phạm vi hóa đơn mặc định**: Chỉ tải hóa đơn trong ngày hôm nay (`today`). Lịch sử các ngày trước chỉ tải khi người dùng chủ động chọn ngày/kỳ cần xem.
> - **Bộ nhớ đệm thiết bị**: Kích hoạt `persistentLocalCache` (IndexedDB) trong Firestore SDK để lưu dữ liệu đệm trên máy, hạn chế tối đa tải lại từ server khi mở lại app.
> - **Phân tách theo vai trò**: Màn hình Bếp và Order được tách độc lập, chỉ nghe `tables` và `menu`, tuyệt đối không tải hóa đơn, sổ quỹ, kho hay lương.

---

### 1. Overview & Core Concept

- **Mục tiêu**: Giảm số lượng document reads từ >50.000 reads/ngày xuống còn ~2.000 - 5.000 reads/ngày cho 2 quán, đảm bảo không bao giờ bị vượt ngưỡng quota miễn phí của Firebase trong vận hành thông thường.
- **Đối tượng sử dụng**:
  - **Nhân viên Order / Chạy bàn**: Chỉ cần dữ liệu bàn, khu vực bàn, thực đơn món để gọi món nhanh, mượt.
  - **Màn hình Bếp**: Chỉ theo dõi đơn gọi món trên các bàn đang hoạt động.
  - **Thu ngân**: Quản lý bàn, thực đơn, ca bán hiện tại và các hóa đơn trong ngày hôm nay.
  - **Chủ quán / Quản lý**: Xem báo cáo tổng hợp ngày hôm nay; chỉ tải lịch sử chi tiết khi vào mục Lịch sử / Kho / Sổ quỹ.

---

### 2. User Experience & Key Flows

1. **Khởi động ứng dụng**:
   - Ứng dụng khởi động tức thì nhờ tải nhanh từ bộ nhớ đệm `persistentLocalCache` thay vì gửi hàng loạt request tải toàn bộ collection từ server.
2. **Vận hành Bếp & Order**:
   - Bếp và Order chuyển trạng thái món ăn trong tích tắc, không bị ảnh hưởng hay phân phối các cập nhật liên quan đến kho, lương, sổ thu chi.
3. **Màn hình Thu ngân & Hóa đơn**:
   - Mặc định danh sách hóa đơn chỉ hiển thị các hóa đơn của **ngày hôm nay** (tính từ 00:00:00 giờ Việt Nam).
   - Khi cần xem hóa đơn các ngày trước hoặc xem theo tháng: Cung cấp bộ lọc ngày rõ ràng; khi người dùng bấm "Xem" thì hệ thống mới truy vấn phân trang (50 bản ghi/trang).
4. **Màn hình Báo cáo & Tổng kết ca**:
   - Báo cáo hôm nay lấy trực tiếp từ các hóa đơn hôm nay đã tải.
   - Báo cáo theo tháng / dài ngày: Khai thác cơ chế tổng hợp hoặc truy vấn có điều kiện, tránh nạp ồ ạt hàng chục nghìn bản ghi vào bộ nhớ.

---

### 3. Key Product Decisions & Trade-Offs

- **Quyết định 1: Xóa bỏ 15 Listener toàn diện ở gốc `App.tsx`**
  - *Phương án*: Thay vì mở 15 `onSnapshot` đồng loạt khi đăng nhập, chuyển sang cơ chế **Selective Subscriptions**:
    - Listener toàn cục (Core): Chỉ giữ `stores` (thông tin quán/gói), `tables` (danh sách bàn), `table_groups` (khu vực), `menu` (thực đơn).
    - Listener theo vai trò: `shifts` (chỉ ca đang mở), `invoices` (chỉ hóa đơn hôm nay).
    - Listener theo nhu cầu (On-demand): `stock_card`, `inventory_logs`, `cash_transactions`, `attendance_records`, `payroll_records` chỉ kết nối khi người dùng thực sự mở trang tương ứng.
  - *Lý do*: Cắt ngay 80% số reads vô ích hàng ngày.

- **Quyết định 2: Lọc ngày theo múi giờ Việt Nam (Asia/Ho_Chi_Minh)**
  - *Phương án*: Tính mốc `startOfDay` từ 00:00:00 giờ địa phương Việt Nam chuyển sang chuẩn ISO UTC để truy vấn: `where('date', '>=', startOfDayIso)`.
  - *Lý do*: Đảm bảo đúng chu kỳ kinh doanh của quán, không bị sai lệch ngày khi đồng bộ giữa các máy.

- **Quyết định 3: Bật Persistent Cache với IndexedDB**
  - *Phương án*: Cấu hình `persistentLocalCache` và `persistentMultipleTabManager` trong `src/lib/firebase.ts`.
  - *Lý do*: Khi nhân viên đóng/mở lại app hoặc mất kết nối ngắn hạn, Firestore sẽ lấy dữ liệu từ cache cục bộ trước, không bị tính phí lại như một truy vấn mới.

---

### 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ỨNG DỤNG FNB MASTER POS                         │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   ┌─────────────────────┐    ┌─────────────────────────────────────┐   │
│   │   Vai trò: Bếp      │    │      Vai trò: Thu ngân / Quản lý    │   │
│   │   - tables (live)   │    │      - tables & menu (live)         │   │
│   │   - menu (cache)    │    │      - shifts (ca mở hiện tại)      │   │
│   └──────────┬──────────┘    │      - invoices (hôm nay)           │   │
│              │               └──────────────────┬──────────────────┘   │
│              ▼                                  ▼                      │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                  Firestore Client Layer                        │   │
│   │  • Persistent Local Cache (IndexedDB)                          │   │
│   │  • Date-bounded Queries: where('date', '>=', startOfDay)       │   │
│   │  • On-Demand View Loaders (Kho, Sổ quỹ, Lương khi mở tab)      │   │
│   └────────────────────────────────┬───────────────────────────────┘   │
│                                    │                                   │
└────────────────────────────────────┼───────────────────────────────────┘
                                     │ (Giảm >90% Reads)
                                     ▼
                ┌────────────────────────────────────────┐
                │         Google Cloud Firestore         │
                │  (Hạn mức an toàn < 5.000 Reads/ngày)   │
                └────────────────────────────────────────┘
```

#### Các giai đoạn thực hiện & Tiến độ:
1. **Giai đoạn 1 (Đã hoàn thành)**: Bật Persistent Local Cache (IndexedDB) và phân tách Role-based Subscriptions trong `src/lib/firebase.ts` & `src/App.tsx`.
2. **Giai đoạn 2 (Đã hoàn thành)**: Tối ưu bộ lọc hóa đơn trong ngày (`startOfDayIso`) theo múi giờ Việt Nam, chuyển đổi listeners On-Demand cho các tab chuyên biệt.
3. **Giai đoạn 3 (Đã hoàn thành)**: Triển khai bảng tổng hợp ngày `daily_stats`, nạp báo cáo doanh thu siêu tốc và backfill 2.772 hóa đơn cho toàn hệ thống.
4. **Giai đoạn 4 (Đã hoàn thành)**: Tối ưu chi phí ghi & tồn kho:
   - **Chống ghi lặp khi thanh toán (P0 Idempotency & Replay Protection)**: Sử dụng `checkoutLockRef` theo `tableId` bảo vệ trong khối `try ... finally`, loại bỏ triệt để tình trạng double click hoặc đa luồng tạo đơn trùng/ghi đè sổ quỹ.
   - **Gộp Delta nguyên liệu & Hàng hóa (P0 & P1 Optimization)**: Gom toàn bộ tiêu hao kho của 1 hóa đơn vào `deltaMap`, đảm bảo chỉ có duy nhất 1 lần `batch.update()` và 1 thẻ kho `stock_card` tổng hợp cho mỗi mặt hàng/nguyên liệu, loại bỏ lỗi ghi đè nhiều lần trong cùng Firestore writeBatch và giảm tới 60-80% chi phí ghi.
   - **Phân tách Menu vs Kho nguyên liệu**: Tách biệt rõ hàng hóa bán trực tiếp (`goods`), món chế biến (`dish` trừ theo `recipe`), và món kèm/topping (`selectedAddOns`); kiểm tra cờ `trackStock !== false`.
   - **Hoàn kho nguyên tử khi hủy hóa đơn**: Gom delta hoàn trả kho và cập nhật đồng bộ thẻ kho, sổ quỹ và thống kê ngày `daily_stats`.
5. **Giai đoạn 5 (Đã hoàn thành)**: Hoàn thiện Bảo mật, Phân quyền API & SuperAdmin (P2):
   - **Rà soát & Hoàn thiện Firestore Rules**: Cập nhật `firestore.rules` khóa chặt vùng tối mật `user_secrets` và `processed_transactions`, bổ sung quyền cho collection hạt nhân `daily_stats`, cho phép SuperAdmin quản trị cấu hình hệ thống, gói cước và APK an toàn.
   - **Phân quyền API Backend (API Authorization)**: Tích hợp Caller Guard vào `/api/save-user`, `/api/delete-user`, `/api/change-password`. Ngăn chặn việc nhân viên tự đổi quyền, tự sửa mức lương hoặc xóa người dùng khác. Đảm bảo cách ly đa quán (`storeId` isolation).
   - **Bảo mật SuperAdmin**: SuperAdmin có đầy đủ quyền quản lý quán, tra cứu mật khẩu admin (AES-256), gia hạn/khóa quán tức thì, phân quyền thao tác chặt chẽ theo từng vai trò (`kitchen`, `order`, `cashier`, `admin`, `superadmin`).

