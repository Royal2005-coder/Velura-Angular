# -*- coding: utf-8 -*-
"""Noi dung muc 3.1.13 cua tai lieu dac ta quy trinh nghiep vu Velura.

Giu nguyen suon ba muc cua ban 3.1.12 cu. Noi dung viet lai theo hanh vi that
cua he thong tren production, doi chieu voi ma nguon va du lieu that ngay
24/09/2026.
"""

TIEU_DE = "3.1.13. Quy trình quản lý giá, khuyến mãi và thống kê (Admin)"

MUC_1 = "3.1.13.1. Mô tả quy trình"
MUC_2 = "3.1.13.2. Quy tắc nghiệp vụ"
MUC_3 = "3.1.13.3. Tình huống ngoại lệ"

# Moi phan tu: ("para", noi dung) hoac ("hinh", ten tep, chu thich, dan nhap)
MO_TA = [
    ("para",
     "Quy trình quản lý giá và khuyến mãi trên trang quản trị Velura cho phép quản trị viên "
     "giá và khuyến mãi thiết lập giá sản phẩm, dựng chiến dịch khuyến mãi, phát hành mã giảm "
     "giá và theo dõi hiệu quả của từng chiến dịch. Trong phạm vi quy trình này, quản trị viên "
     "giá và khuyến mãi được hiểu là người giữ vai trò thao tác nghiệp vụ trên phân hệ giá và "
     "khuyến mãi. So với bản 3.1.12, quy trình được mở rộng để mô tả trọn vẹn cả phía khách "
     "hàng, vì phần lớn rủi ro vận hành nằm ở chỗ hai phía không khớp nhau."),

    ("para",
     "Về quản lý giá, quản trị viên quy định giá gốc và giá bán cho từng sản phẩm. Giá bán là "
     "con số khách nhìn thấy trên trang sản phẩm và cũng là con số hệ thống dùng để tính tiền; "
     "giá gốc chỉ phục vụ việc gạch ngang và tính phần trăm giảm. Vì vậy giá bán phải nhỏ hơn "
     "giá gốc, nếu không khách sẽ phải trả nhiều hơn mức niêm yết. Mọi thay đổi giá được ghi "
     "vào lịch sử giá kèm người thực hiện, thời điểm, giá trị cũ và giá trị mới, phục vụ tra "
     "cứu và đối soát về sau."),

    ("para",
     "Về chương trình khuyến mãi, chiến dịch trong Velura là vỏ chứa chứ không phải một cơ chế "
     "đổi giá. Một chiến dịch giữ bốn thứ: khung thời gian hiệu lực, ngân sách, bộ mã giảm giá "
     "thuộc về nó, và nội dung trình bày trên trang Ưu đãi. Chiến dịch không ghi đè giá bán của "
     "sản phẩm; toàn bộ phần ưu đãi tới tay khách đi qua mã giảm giá. Cách phân định này khác "
     "bản 3.1.12, nơi mô tả chiến dịch tự áp giá khuyến mãi lên sản phẩm rồi khôi phục giá cũ "
     "khi hết hạn. Phân định lại vì hai lý do: giá bán đã có lịch sử thay đổi riêng nên để "
     "chiến dịch ghi đè sẽ tạo hai nguồn sự thật về giá của cùng một sản phẩm, và trên hệ thống "
     "hiện tại chưa loại chiến dịch nào thực sự đổi giá của bất kỳ sản phẩm nào."),

    ("hinh", "khuyenmai-3-17-thiet-lap-chien-dich.png",
     "Hình 3.17: BPMN quy trình thiết lập chiến dịch khuyến mãi",
     "Sơ đồ dưới đây mô tả bước thiết lập chiến dịch, từ lúc quản trị viên khai báo thông tin "
     "tới lúc chiến dịch được ghi nhận và chờ phát hành mã."),

    ("para",
     "Ngân sách chiến dịch được kiểm soát ở hai chỗ khác nhau, phục vụ hai mục đích khác nhau. "
     "Ở thời điểm phát hành mã, hệ thống quy đổi ngân sách tổng thành số mã tối đa được phép "
     "phát hành, bằng ngân sách chia cho trần giảm của mỗi lượt dùng. Ví dụ ngân sách "
     "50.000.000đ với mã giảm 30% nhưng tối đa 10.000đ cho ra trần 5.000 mã, và trần này chặn "
     "ngay khi quản trị viên bấm lưu mã thứ 5.001. Ở thời điểm vận hành, phần ngân sách đã dùng "
     "được cộng dồn theo đúng số tiền giảm thực tế của từng đơn. Bản 3.1.12 quy định theo dõi "
     "theo công thức trần, nghĩa là mỗi lượt dùng đều tính bằng mức giảm kịch trần. Cách đó báo "
     "cáo một con số cao hơn thực chi và làm chiến dịch dừng sớm hơn mức cần thiết, nên phần "
     "theo dõi được chuyển sang số tiền thực, còn phần chặn trần vẫn giữ nguyên ở khâu phát hành."),

    ("para",
     "Mỗi mã giảm giá mang một bộ thuộc tính: mã code duy nhất, loại giảm gồm số tiền cố định, "
     "phần trăm kèm trần giảm hoặc miễn phí vận chuyển, giá trị đơn hàng tối thiểu, nhóm khách "
     "áp dụng, số lượt tối đa toàn hệ thống, số lượt tối đa trên mỗi khách và khung thời gian "
     "hiệu lực. Quản trị viên tạo mã thủ công hoặc sinh hàng loạt theo tiền tố. Mọi thao tác ghi "
     "lên chiến dịch và mã đều đi qua hàm trên cơ sở dữ liệu có kiểm vai trò và sinh một dòng "
     "nhật ký kèm người thực hiện, thời điểm và phần dữ liệu thay đổi; không còn đường ghi nào "
     "bỏ qua bước này."),

    ("hinh", "khuyenmai-3-18-phat-hanh-ma.png",
     "Hình 3.18: BPMN quy trình phát hành mã giảm giá và kích hoạt chiến dịch",
     "Sơ đồ dưới đây mô tả bước phát hành mã vào một chiến dịch đã có trần số mã, và bước kích "
     "hoạt để mã bắt đầu phục vụ khách."),

    ("para",
     "Phía khách hàng, Velura không lưu một bản sao mã riêng cho từng người. Khi khách mở giỏ "
     "hàng hoặc trang Ưu đãi, hệ thống lấy bộ mã đang hoạt động, lọc theo đối tượng rồi chấm "
     "từng mã trên giá trị giỏ hiện tại. Thứ tự chấm có chủ đích: các lý do thuộc về bản thân mã "
     "được xét trước, gồm mã ngừng hoạt động, chưa tới hạn, đã hết hạn và hết lượt toàn hệ thống; "
     "tiếp đó tới trạng thái chiến dịch cha, gồm tạm dừng, ngoài khung ngày và cạn ngân sách; rồi "
     "tới nhóm khách áp dụng; rồi tới số lượt chính khách đã dùng; cuối cùng mới tới giá trị đơn "
     "tối thiểu. Xếp như vậy để câu giải thích hiển thị cho khách nêu đúng nguyên nhân gốc, thay "
     "vì mời khách mua thêm hàng cho một mã vốn đã hết hạn. Mã chưa đủ điều kiện vẫn được hiển "
     "thị kèm lý do cụ thể và số tiền còn thiếu để đạt điều kiện."),

    ("para",
     "Mỗi đơn chỉ áp một mã. Khi khách chưa tự chọn, hệ thống áp sẵn mã cho số tiền giảm thực tế "
     "lớn nhất sau khi đã áp trần, không so theo phần trăm danh nghĩa: mã giảm 30% nhưng tối đa "
     "10.000đ trên một đơn 200.000đ chỉ mang lại 10.000đ, nên thua một mã giảm thẳng 15.000đ. "
     "Khi hai mã cho cùng số tiền, hệ thống ưu tiên mã hết hạn sớm hơn để mã còn dài hạn được để "
     "dành cho lần mua sau. Khách đổi sang mã khác thì hệ thống chấm lại và giữ đúng lựa chọn "
     "của khách. Miễn phí vận chuyển không phải một loại mã mà là ngưỡng theo giá trị đơn do máy "
     "chủ giữ, nên khách vẫn được miễn phí vận chuyển đồng thời với một mã giảm giá hợp lệ."),

    ("hinh", "khuyenmai-3-19-vi-ma-giam-gia.png",
     "Hình 3.19: BPMN quy trình ví mã giảm giá và chọn mã tốt nhất cho khách",
     "Sơ đồ dưới đây mô tả tương tác giữa khách hàng và dịch vụ khuyến mãi khi khách xem ví mã, "
     "bao gồm cả nhánh khách chủ động đổi sang mã khác."),

    ("para",
     "Khi khách bấm đặt hàng, máy chủ tự tra bảng giá theo từng biến thể, tự cộng tạm tính, tự "
     "xác định phí vận chuyển theo ngưỡng và chấm lại mã một lần nữa tại đúng thời điểm đặt đơn. "
     "Toàn bộ số tiền do trình duyệt gửi lên đều bị bỏ qua. Nếu đơn giá trình duyệt khai lệch so "
     "với bảng giá, đơn bị từ chối và khách được yêu cầu tải lại giỏ, vì khoảng lệch đó thường là "
     "dấu hiệu giá vừa thay đổi trong lúc khách còn đang ở giỏ hàng. Lượt dùng mã và phần ngân "
     "sách tương ứng được ghi trong cùng một giao dịch có khoá dòng, nên hai đơn đặt gần như cùng "
     "lúc không ghi đè số lượt của nhau. Đơn bị huỷ thì cả lượt dùng lẫn phần ngân sách đã cộng "
     "được hoàn lại."),

    ("hinh", "khuyenmai-3-20-chot-tien-dat-don.png",
     "Hình 3.20: BPMN quy trình chốt tiền và ghi nhận ưu đãi khi đặt đơn",
     "Sơ đồ dưới đây mô tả đường đi của một đơn hàng có áp mã, từ lúc khách xác nhận đặt hàng "
     "tới lúc ưu đãi được ghi nhận, kèm hai nhánh từ chối."),

    ("para",
     "Combo cho phép gom nhiều sản phẩm thành một set theo mô hình gợi ý trang phục của Velura. "
     "Khi tạo combo, hệ thống so giá combo với tổng giá bán hiện hành của từng sản phẩm lẻ và "
     "cảnh báo nếu mức chênh không đạt tối thiểu 5%. Về mặt đơn hàng, combo không tạo ra một mặt "
     "hàng ảo: nó được tách thành các dòng hàng riêng, mỗi dòng mang mã biến thể thật và đơn giá "
     "catalog của chính sản phẩm thành phần. Nhờ vậy quy tắc tính tiền nêu trên áp được cho cả "
     "đơn có combo mà không cần ngoại lệ, và tồn kho được trừ đúng tới từng biến thể kích cỡ và "
     "màu sắc."),

    ("para",
     "Bảng thống kê hiệu quả khuyến mãi đọc số liệu từ bảng đơn hàng thật, gồm tỉ lệ dùng mã, "
     "doanh thu từ đơn có mã, giá trị đơn trung bình của đơn có mã so với đơn không mã, và so "
     "sánh hiệu quả giữa các chiến dịch. Trạng thái chiến dịch trong báo cáo lấy từ cùng một "
     "nguồn với bảng danh sách, gồm năm trạng thái là chờ tới ngày, đang chạy, tạm dừng, đã kết "
     "thúc và hết ngân sách, để báo cáo và màn vận hành không nói hai điều khác nhau về cùng một "
     "chiến dịch. Quyền xem báo cáo được cấp riêng cho vai trò chỉ đọc, dành cho trưởng bộ phận "
     "kinh doanh cần số liệu để ra quyết định nhưng không thao tác nghiệp vụ, theo nguyên tắc "
     "quyền tối thiểu."),

    ("hinh", "khuyenmai-3-21-ngan-sach-thong-ke.png",
     "Hình 3.21: BPMN quy trình giám sát ngân sách, tự động dừng và thống kê",
     "Sơ đồ dưới đây mô tả vòng giám sát chạy nền theo lịch, cơ chế tự dừng khi chạm trần ngân "
     "sách hoặc quá hạn, và bước quản trị viên đọc thống kê."),
]

BANG_CAPTION = ("Bảng 3.15: Bảng quy tắc nghiệp vụ - Quy trình quản lý giá, khuyến mãi "
                "và thống kê")

BANG_HEADER = ["Mã quy tắc", "Tên quy tắc", "Mô tả chi tiết", "Hành động hệ thống"]

BANG = [
    ("AD_PRICE_01", "Giá bán không vượt giá gốc",
     "Khi sản phẩm được đặt giá bán, giá đó phải nhỏ hơn giá gốc. Giá bán là con số khách trả, "
     "giá gốc chỉ để gạch ngang, nên giá bán cao hơn giá gốc khiến khách trả nhiều hơn mức niêm yết.",
     "Chặn lưu khi giá bán lớn hơn hoặc bằng giá gốc và nêu rõ cả hai con số trong thông báo. "
     "Với dữ liệu đã có sai lệch, hệ thống liệt kê để quản trị viên rà soát, không tự sửa."),

    ("AD_PRICE_02", "Ghi nhận lịch sử thay đổi giá",
     "Mọi thay đổi giá gốc hoặc giá bán của sản phẩm và biến thể phải được ghi nhận đầy đủ.",
     "Tự động lưu một bản ghi gồm người thực hiện, thời điểm, giá trị cũ, giá trị mới và lý do "
     "nếu có."),

    ("AD_PROMO_01", "Chiến dịch là vỏ chứa mã, không đổi giá sản phẩm",
     "Chiến dịch quản lý khung thời gian, ngân sách, bộ mã và nội dung trình bày. Ưu đãi tới tay "
     "khách chỉ qua mã giảm giá thuộc chiến dịch.",
     "Bật hoặc tắt chiến dịch chỉ bật hoặc tắt bộ mã thuộc chiến dịch. Giá bán trên trang sản "
     "phẩm không thay đổi theo chiến dịch."),

    ("AD_PROMO_02", "Hiệu lực và đồng bộ theo lịch",
     "Mỗi chiến dịch có thời điểm bắt đầu và kết thúc rõ ràng. Trạng thái vòng đời gồm chờ tới "
     "ngày, đang chạy, tạm dừng, đã kết thúc và hết ngân sách.",
     "Bộ lịch bật chiến dịch khi tới ngày bắt đầu và tắt khi quá ngày kết thúc. Quá ngày kết "
     "thúc là trạng thái áp đảo, kể cả khi chiến dịch bị tắt tay hoặc đã cạn ngân sách."),

    ("AD_PROMO_03", "Trần số mã quy đổi từ ngân sách",
     "Số mã tối đa được phép phát hành bằng ngân sách tổng chia cho trần giảm của mỗi lượt dùng, "
     "tính riêng cho từng chiến dịch.",
     "Kiểm tại thời điểm phát hành mã. Vượt trần thì từ chối lưu và nêu rõ số mã đã phát hành "
     "trên tổng số mã cho phép."),

    ("AD_PROMO_04", "Theo dõi ngân sách theo số tiền giảm thực tế",
     "Phần ngân sách đã dùng cộng dồn bằng đúng số tiền giảm của từng đơn, không tính theo mức "
     "trần cấu hình.",
     "Cập nhật sau mỗi đơn có áp mã. Chạm trần thì dừng chiến dịch và tắt toàn bộ mã thuộc chiến "
     "dịch trong cùng một giao dịch, ghi một dòng nhật ký và cảnh báo cho quản trị viên."),

    ("AD_PROMO_05", "Chồng lấn chỉ cảnh báo, không tự gộp",
     "Hai chiến dịch trùng khung thời gian và cùng đụng tới một danh mục được coi là chồng lấn.",
     "Gắn nhãn cảnh báo trên bảng danh sách kèm tên các chiến dịch liên quan. Hệ thống không cộng "
     "dồn mức giảm và không tự chọn hộ giữa hai chiến dịch."),

    ("AD_PROMO_06", "Thời gian lưu trữ chiến dịch",
     "Các chiến dịch đã kết thúc được lưu tối thiểu 12 tháng để phục vụ thống kê và đối chiếu.",
     "Đánh dấu đã kết thúc và giữ nguyên bản ghi, không xoá khỏi cơ sở dữ liệu."),

    ("AD_PROMO_07", "Mọi thao tác ghi đều qua hàm có kiểm quyền và ghi nhật ký",
     "Tạo, sửa, bật và tắt chiến dịch hoặc mã đều phải đi qua hàm trên cơ sở dữ liệu có kiểm vai "
     "trò, không ghi thẳng bằng khoá dịch vụ.",
     "Từ chối ngay trong hàm nếu vai trò không đủ quyền. Mỗi lần ghi thành công sinh một dòng "
     "nhật ký kèm người thực hiện, thời điểm và phần dữ liệu thay đổi."),

    ("AD_VOUCHER_01", "Tính duy nhất của mã giảm giá",
     "Mỗi mã giảm giá phải có code duy nhất trong toàn hệ thống.",
     "Kiểm tra code trước khi tạo và báo lỗi mã đã tồn tại nếu trùng."),

    ("AD_VOUCHER_02", "Thứ tự kiểm tra khi chấm một mã",
     "Mã được chấm theo tám bước có thứ tự: mã ngừng hoạt động, chưa tới hạn, đã hết hạn, hết "
     "lượt toàn hệ thống, chiến dịch cha dừng hoặc ngoài khung ngày hoặc cạn ngân sách, sai nhóm "
     "khách, hết lượt của chính khách, chưa đạt giá trị đơn tối thiểu.",
     "Dừng ở bước đầu tiên không đạt và hiển thị đúng lý do của bước đó. Riêng bước giá trị đơn "
     "tối thiểu kèm theo số tiền khách cần mua thêm."),

    ("AD_VOUCHER_03", "Sinh mã hàng loạt không trùng",
     "Khi sinh mã tự động, hệ thống tạo các code ngẫu nhiên theo đúng số lượng và tiền tố đã cấu "
     "hình, không được trùng mã đã có.",
     "Kiểm tra từng mã trước khi lưu, sinh lại tối đa ba lần nếu trùng. Sau ba lần vẫn trùng thì "
     "ghi nhật ký lỗi và báo quản trị viên kiểm tra thủ công."),

    ("AD_VOUCHER_04", "Giới hạn lượt dùng theo khách",
     "Mã có thể giới hạn số lần dùng trên mỗi khách. Giới hạn này chỉ áp được cho thành viên, vì "
     "khách vãng lai chưa có lịch sử đơn gắn với tài khoản.",
     "Đếm số đơn chưa huỷ của khách có dùng mã đó. Vượt giới hạn thì từ chối và báo khách đã dùng "
     "hết lượt cho mã này."),

    ("AD_VOUCHER_05", "Mỗi đơn một mã, chọn theo số tiền giảm thực tế",
     "Một đơn chỉ áp một mã, không cộng dồn. Khi khách chưa tự chọn, hệ thống chọn mã mang lại "
     "số tiền giảm lớn nhất sau khi đã áp trần.",
     "So sánh theo số tiền thực nhận, không theo phần trăm danh nghĩa. Hai mã bằng nhau thì ưu "
     "tiên mã hết hạn sớm hơn. Khách tự đổi mã thì giữ đúng lựa chọn của khách."),

    ("AD_VOUCHER_06", "Mã ngừng theo chiến dịch cha",
     "Mã thuộc một chiến dịch đã tạm dừng, đã kết thúc hoặc đã cạn ngân sách thì không dùng được, "
     "kể cả khi bản thân mã vẫn đang bật.",
     "Tắt toàn bộ mã con khi chiến dịch dừng, và chặn thêm một lần nữa ở bước chấm mã để một lần "
     "tắt lỡ nhịp không biến thành giảm giá ngoài ý muốn."),

    ("AD_ORDER_01", "Máy chủ là nơi duy nhất chốt số tiền",
     "Đơn giá, tạm tính, phí vận chuyển, số tiền giảm và tổng thanh toán đều do máy chủ tính từ "
     "bảng giá và từ kết quả chấm mã.",
     "Bỏ qua mọi số tiền do trình duyệt gửi lên. Đơn giá trình duyệt khai lệch bảng giá thì từ "
     "chối đơn và yêu cầu khách tải lại giỏ hàng."),

    ("AD_ORDER_02", "Giảm giá không vượt giá trị đơn",
     "Số tiền giảm của một đơn không bao giờ lớn hơn giá trị hàng hoá của đơn đó.",
     "Cắt phần vượt trước khi tính tổng thanh toán, để tổng tiền không bao giờ âm."),

    ("AD_ORDER_03", "Miễn phí vận chuyển là ngưỡng, không phải mã",
     "Miễn phí vận chuyển được xác định theo ngưỡng giá trị đơn do máy chủ giữ, áp độc lập với "
     "mã giảm giá.",
     "Tính phí theo ngưỡng cấu hình ở máy chủ và hiển thị số tiền còn thiếu để đạt ngưỡng. Khách "
     "vẫn dùng được một mã giảm giá cùng lúc."),

    ("AD_ORDER_04", "Ghi lượt dùng và ngân sách trong cùng giao dịch",
     "Việc tăng số lượt đã dùng của mã và cộng dồn ngân sách chiến dịch phải xảy ra trọn vẹn "
     "hoặc không xảy ra.",
     "Khoá dòng mã khi ghi, nên hai đơn đặt cùng lúc không ghi đè số lượt của nhau. Huỷ đơn thì "
     "hoàn lại cả lượt dùng lẫn phần ngân sách đã cộng."),

    ("AD_COMBO_01", "Giá combo thấp hơn tổng giá lẻ",
     "Giá của một combo phải thấp hơn tổng giá bán hiện hành của các sản phẩm thành phần.",
     "Tự động tính tổng giá lẻ khi tạo combo và cảnh báo nếu mức chênh không đạt tối thiểu 5%."),

    ("AD_COMBO_02", "Combo phân rã thành dòng hàng theo biến thể",
     "Combo không phải một mặt hàng riêng. Khi vào giỏ, combo được tách thành các dòng hàng, mỗi "
     "dòng mang mã biến thể thật và đơn giá catalog của sản phẩm thành phần.",
     "Áp cùng một quy tắc tính tiền như đơn thường, không cần ngoại lệ cho combo. Tồn kho trừ "
     "đúng tới từng biến thể sau khi đơn được xác nhận."),

    ("AD_STATS_01", "Thống kê đọc từ đơn hàng thật",
     "Các chỉ số hiệu quả khuyến mãi được tính từ bảng đơn hàng, không phải từ số dòng trong "
     "bảng chiến dịch hay bảng mã.",
     "Tổng hợp tỉ lệ dùng mã, doanh thu từ đơn có mã, giá trị đơn trung bình có mã so với không "
     "mã và so sánh giữa các chiến dịch. Cho phép xuất báo cáo."),

    ("AD_STATS_02", "Phân quyền xem dữ liệu thống kê",
     "Chỉ vai trò được cấp quyền mới xem được báo cáo doanh thu và hiệu quả khuyến mãi.",
     "Kiểm vai trò trước khi trả dữ liệu. Vai trò chỉ đọc xem và xuất được báo cáo nhưng không "
     "thao tác nghiệp vụ trên giá, chiến dịch hay mã."),
]

NGOAI_LE = [
    ("Tình huống 1: Giá bán được nhập cao hơn giá gốc",
     "Quản trị viên nhập giá bán lớn hơn giá gốc, thường do nhầm thứ tự hai ô. Trang sản phẩm "
     "hiển thị giá bán nên khách sẽ trả cao hơn mức niêm yết, đồng thời phần trăm giảm hiển thị "
     "thành số âm.",
     "Hệ thống chặn lưu và nêu rõ hai con số vừa nhập. Với dữ liệu đã tồn tại trước khi quy tắc "
     "này có hiệu lực, hệ thống lập danh sách các sản phẩm đang sai lệch kèm khoảng chênh để bộ "
     "phận kinh doanh quyết định, không tự đảo hai cột giá."),

    ("Tình huống 2: Trình duyệt gửi lên đơn giá lệch bảng giá",
     "Giỏ hàng của khách giữ giá cũ do giá vừa được cập nhật, hoặc dữ liệu gửi lên bị can thiệp. "
     "Nếu máy chủ ghi nguyên văn số tiền nhận được thì đơn hàng sẽ được chốt ở một mức giá không "
     "có trong bảng giá.",
     "Máy chủ tra lại bảng giá theo từng biến thể và đối chiếu với số khách khai. Lệch thì từ "
     "chối đơn, ghi nhật ký cả hai con số và yêu cầu khách tải lại giỏ hàng. Khách được giữ "
     "nguyên các dòng hàng đã chọn."),

    ("Tình huống 3: Hai chiến dịch chồng lấn thời gian và danh mục",
     "Hai chiến dịch cùng chạy trong một khoảng thời gian và cùng đụng tới một danh mục sản "
     "phẩm, chẳng hạn một chiến dịch theo mùa và một chiến dịch giờ vàng.",
     "Hệ thống gắn nhãn cảnh báo trên bảng danh sách, nêu tên các chiến dịch liên quan. Việc chọn "
     "giữ hay dừng chiến dịch nào thuộc về quản trị viên. Ở phía khách, mỗi đơn vẫn chỉ áp một "
     "mã và mã được chọn là mã cho số tiền giảm lớn nhất, nên không có tình huống cộng dồn."),

    ("Tình huống 4: Ngân sách cạn trước khi hết thời hạn",
     "Chiến dịch có ngân sách 50.000.000đ, mã giảm 30% tối đa 10.000đ, trần phát hành 5.000 mã. "
     "Mới sang ngày thứ ba trên bảy ngày dự kiến thì phần ngân sách đã dùng chạm trần.",
     "Hệ thống dừng chiến dịch ngay trong giao dịch ghi lượt dùng cuối cùng, tắt toàn bộ mã thuộc "
     "chiến dịch, chuyển trạng thái sang hết ngân sách và ghi một dòng nhật ký nêu rõ lý do. "
     "Khách không còn thấy và không áp được các mã này. Quản trị viên nhận cảnh báo trên bảng "
     "danh sách."),

    ("Tình huống 5: Chiến dịch đã dừng nhưng mã con chưa tắt kịp",
     "Quản trị viên tạm dừng một chiến dịch. Thao tác tắt mã con chạy theo dạng lan truyền nên "
     "có thể lỡ nhịp trong khoảnh khắc, để lại một mã vẫn đang bật.",
     "Bước chấm mã xét trạng thái chiến dịch cha một lần nữa ngay trước khi cho phép áp mã. Mã "
     "thuộc chiến dịch đã dừng bị từ chối với lý do chiến dịch của mã đã tạm dừng, kể cả khi cờ "
     "trên bản thân mã vẫn còn bật."),

    ("Tình huống 6: Mã sinh tự động bị trùng",
     "Khi sinh một lô mã lớn, bộ sinh ngẫu nhiên tạo ra một code đã tồn tại.",
     "Hệ thống kiểm tra từng mã trước khi lưu và sinh lại tối đa ba lần. Sau ba lần vẫn trùng "
     "thì dừng lô đó, ghi nhật ký lỗi và báo quản trị viên kiểm tra thủ công. Các mã đã sinh "
     "thành công trong lô vẫn được giữ."),

    ("Tình huống 7: Hai khách dùng lượt cuối cùng của một mã tại cùng thời điểm",
     "Mã chỉ còn một lượt trên toàn hệ thống. Hai khách bấm đặt hàng gần như cùng lúc.",
     "Việc ghi lượt dùng khoá dòng mã nên hai yêu cầu xếp hàng. Yêu cầu đầu tiên nhận lượt cuối. "
     "Yêu cầu thứ hai bị từ chối ở bước chấm lại mã với lý do mã đã hết lượt, và khách được mời "
     "chọn mã khác trong ví."),

    ("Tình huống 8: Khách huỷ đơn đã áp mã",
     "Một đơn đã ghi nhận lượt dùng mã và đã cộng ngân sách chiến dịch, sau đó bị huỷ.",
     "Hệ thống trả lại một lượt dùng cho mã và trừ đúng phần ngân sách đã cộng của đơn đó. Nếu "
     "chiến dịch trước đó đã dừng vì chạm trần, việc hoàn lại không tự bật lại chiến dịch; quản "
     "trị viên quyết định có kích hoạt lại hay không."),

    ("Tình huống 9: Chiến dịch đang chạy nhưng không mã nào còn hiệu lực",
     "Chiến dịch nằm trong khung thời gian và đang bật, nhưng toàn bộ mã của nó đã hết hạn hoặc "
     "đã bị tắt. Trường hợp gần giống là chiến dịch đã đặt ngân sách nhưng chưa phát mã nào, khi "
     "đó thanh ngân sách đứng yên ở 0 mà không ai biết lý do.",
     "Hệ thống gắn cảnh báo tương ứng trên bảng danh sách: đang chạy nhưng không mã nào còn hiệu "
     "lực, hoặc chiến dịch chưa có mã nên ngân sách không được theo dõi. Cảnh báo hiện ngay trên "
     "dòng của chiến dịch thay vì chỉ lộ ra khi có người mở đúng chiến dịch đó."),

    ("Tình huống 10: Sản phẩm thành phần của combo ngừng kinh doanh hoặc hết tồn",
     "Một combo gồm ba sản phẩm, sau đó một sản phẩm bị chuyển sang ngừng kinh doanh, hoặc hết "
     "tồn kho do được bán lẻ cho các đơn khác.",
     "Trường hợp ngừng kinh doanh, hệ thống vô hiệu hoá combo và báo quản trị viên cập nhật lại "
     "danh sách thành phần. Trường hợp hết tồn, hệ thống chuyển combo sang tạm hết hàng và ẩn nút "
     "thêm vào giỏ, đồng thời cảnh báo thiếu hụt tồn kho trên trang quản trị. Combo trở lại bán "
     "được ngay khi thành phần đó có tồn trở lại."),
]
