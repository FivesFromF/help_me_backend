import base64
import cv2
import numpy as np
from regconition_original import FaceProcessor

# Khởi tạo mô hình ở Global Scope. 
# Lambda sẽ tốn khoảng 5-10s ở lần đầu (Cold Start) để nạp biến này vào RAM.
# Những lần quét tiếp theo (Warm Start) sẽ tận dụng lại biến này nên cực kỳ nhanh.
processor = FaceProcessor()

def lambda_handler(event, context):
    """
    AWS Lambda Handler (nhận trực tiếp Payload từ hàm Node.js gọi sang).
    Event bắt buộc có cấu trúc: {"image": "chuỗi_base64..."}
    """
    try:
        # Nếu được gọi ngầm từ EventBridge (giữ nhiệt), bỏ qua việc xử lý ảnh
        if event.get("is_warmup"):
            return {"success": True, "message": "Warm-up successful"}
            
        if "image" not in event:
            return {"success": False, "error": "Missing 'image' key in event payload"}
            
        base64_img = event["image"]
        contents = base64.b64decode(base64_img)
        
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if img is None:
            return {"success": False, "error": "Invalid image format or corrupted file"}

        # Bóc tách khuôn mặt bằng InsightFace
        success, result = processor.process_image(img)
        
        if success:
            return {
                "success": True,
                "embedding": result # Mảng 512-dimension
            }
        else:
            return {"success": False, "error": result}

    except Exception as e:
        return {"success": False, "error": f"Internal AI Service Error: {str(e)}"}
