# Quy trình nhận dạng: Nhận vào 1 ảnh
# 1. Mediapipe kiểm tra ảnh có khuôn mặt hợp lệ không -> Không thì trả về app cho chụp lại
# 2. Anti-spoofing kiểm tra ảnh có phải là ảnh chụp người thật không -> Không thì trả về app cho chụp lại
# 3. Nếu hợp lệ, crop ảnh và trích xuất đặc trưng bằng EdgeFace
# 4. Databse bên ngoài nhận kết quả, tiến hành so sánh với đặc trưng.npy đã lưu để xác định danh tính (dùng order by/cosine similartiy/ ...)
# 5. Thông tin người giống nhất sẽ được gửi từ database tới app để hiển thị


import os
import cv2
import torch
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
from anti_spoofing.anti_fake import test
from edgeface.backbones import get_model


INPUT_PATH = "./users/a.jpg"                        # Dùng tạm ảnh này để test - nhận vào 1 tấm ảnh chụp trực tiếp
OUTPUT_NPY = "./feature_extracted/vertify.npy"      # Lưu tạm kết quả trích xuất vào đây để nhìn được, thực tế sẽ gửi file này qua database để nó so sánh bên đó.


# Configuration - Thay đổi tùy ý
CONFIG = {
    "paths": {
        "anti_spoof_model": os.path.join(os.path.dirname(__file__), "anti_spoofing/resources/anti_spoof_models/2.7_80x80_MiniFASNetV2.pth"),       #PATH KHÔNG ĐỔI
        "mediapipe_task": os.path.join(os.path.dirname(__file__), "face_landmark/face_landmarker.task"),                                           #PATH KHÔNG ĐỔI
        "edgeface_weights": os.path.join(os.path.dirname(__file__), "edgeface/edgeface_s_gamma_05.pt"),                                            #PATH KHÔNG ĐỔI  
    },
    "thresholds": {
        "yaw": 15,                  # Độ nghiêng tối đa hợp lệ
        "pitch": 15,                # Độ ngước lên xuống tối đa hợp lệ
        "min_face_ratio": 0.10,     # Mặt phải chiếm ít nhất 10% diện tích ảnh
        "max_face_ratio": 0.50,     # Mặt không được chiếm quá 50% diện tích ảnh
    },
    "dimensions": {
        "edgeface_size": (112, 112),
        "crop_padding": 0.15
    }
}

# Do not change
class FaceProcessor:
    def __init__(self, config=CONFIG):
        self.cfg = config
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        base_options = python.BaseOptions(model_asset_path=self.cfg["paths"]["mediapipe_task"])
        options = vision.FaceLandmarkerOptions(
            base_options=base_options,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
            num_faces=1
        )
        self.detector = vision.FaceLandmarker.create_from_options(options)

        self.face_engine = get_model("edgeface_s_gamma_05")
        self.face_engine.load_state_dict(torch.load(self.cfg["paths"]["edgeface_weights"], map_location=self.device))
        self.face_engine.to(self.device).eval()

    @torch.no_grad()
    def _extract_embedding(self, face_img):
        """Internal helper to convert face crop to feature vector."""
        face_img = cv2.resize(face_img, self.cfg["dimensions"]["edgeface_size"])
        face_img = cv2.cvtColor(face_img, cv2.COLOR_BGR2RGB)
        # Standardize for EdgeFace
        face_img = ((face_img.astype(np.float32) - 127.5) / 128.0)
        face_img = np.transpose(face_img, (2, 0, 1))
        tensor = torch.from_numpy(face_img).unsqueeze(0).to(self.device)
        
        embedding = self.face_engine(tensor)
        embedding = torch.nn.functional.normalize(embedding, p=2, dim=1)
        return embedding.cpu().numpy().flatten().tolist()

    def process_image(self, frame):
        """
        Main entry point for API calls. 
        Returns: (success_boolean, data_or_error_message)
        """
        if frame is None:
            return False, "No image data received"

        h, w, _ = frame.shape
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        
        result = self.detector.detect(mp_image)
        
        # --- 1. Validation (MediaPipe) ---
        if not result.face_landmarks:
            return False, "\nNo face detected. Please look directly at the camera."

        matrix = result.facial_transformation_matrixes[0]
        yaw = np.degrees(np.arctan2(matrix[0, 2], matrix[2, 2]))
        pitch = np.degrees(np.arcsin(-matrix[1, 2]))

        if abs(yaw) > self.cfg["thresholds"]["yaw"] or abs(pitch) > self.cfg["thresholds"]["pitch"]:
            return False, f"\nFace tilted too much. Please face the camera straight."

        landmarks = result.face_landmarks[0]
        x_coords = [lm.x * w for lm in landmarks]
        y_coords = [lm.y * h for lm in landmarks]
        x_min, x_max, y_min, y_max = int(min(x_coords)), int(max(x_coords)), int(min(y_coords)), int(max(y_coords))
        
        face_ratio = ((x_max - x_min) * (y_max - y_min)) / (h * w)
        if face_ratio < self.cfg["thresholds"]["min_face_ratio"]:
            return False, "\nFace too far away. Please move closer."
        if face_ratio > self.cfg["thresholds"]["max_face_ratio"]:
            return False, "\nFace too close. Please move back."
        
        print(f"MediaPipe Passed - Pose: Yaw = {yaw:.2f}°, Pitch = {pitch:.2f}°, Face Ratio: {face_ratio:.4f} \n")
        
        # --- 2. Cropping ---
        pad = self.cfg["dimensions"]["crop_padding"]
        pad_w, pad_h = int((x_max - x_min) * pad), int((y_max - y_min) * pad)
        fx1, fy1 = max(0, x_min - pad_w), max(0, y_min - pad_h)
        fx2, fy2 = min(w, x_max + pad_w), min(h, y_max + pad_h)
        face_crop = frame[fy1:fy2, fx1:fx2]

        # --- 3. Anti-Spoofing ---
        temp_filename = f"temp_verify_{os.getpid()}.jpg"
        cv2.imwrite(temp_filename, face_crop)
        try:
            is_real = test(temp_filename, self.cfg["paths"]["anti_spoof_model"], device_id=0 if torch.cuda.is_available() else -1)
        finally:
            if os.path.exists(temp_filename):
                os.remove(temp_filename)

        if is_real != 1:
            return False, "Spoofing detected. Please use a real face."

        # --- 4. Feature Extraction ---
        embedding = self._extract_embedding(face_crop)
        
        return True, embedding


# Thay đổi tùy ý
if __name__ == "__main__":

    image_path = INPUT_PATH
    output_npy = OUTPUT_NPY
    
    processor = FaceProcessor()
    
    img = cv2.imread(image_path)
    
    if img is None:
        print(f"\nError: Could not read image at {image_path}")
    else:
        print(f"\nProcessing image: {image_path}\n")
        
        success, result = processor.process_image(img)
        
        if success:
            embedding_array = np.array(result, dtype=np.float32)
            
            np.save(output_npy, embedding_array)
            
            print(f"\nEmbedding saved to: {output_npy}")
            print(f"\nVector Shape: {embedding_array.shape}\n") 
        else:
            print(f"--- Validation Failed: {result} ---")