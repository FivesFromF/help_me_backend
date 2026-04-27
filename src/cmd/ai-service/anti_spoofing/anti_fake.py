# -*- coding: utf-8 -*-
import os
import cv2
import numpy as np
import argparse
import warnings
import time

from anti_spoofing.src.anti_spoof_predict import AntiSpoofPredict
from anti_spoofing.src.generate_patches import CropImage
from anti_spoofing.src.utility import parse_model_name

warnings.filterwarnings('ignore')

def check_image(image):
    if image is None:
        return False
    return True

def test(image_path, model_path, device_id):
    model_test = AntiSpoofPredict(device_id)
    image_cropper = CropImage()
    
    if not os.path.exists(image_path):
        print(f"ERROR: Image file not found at: {image_path}")
        return
        
    image = cv2.imread(image_path)
    if not check_image(image):
        print("ERROR: Image failed the size/ratio check.")
        return

    image_bbox = model_test.get_bbox(image)
    
    model_name = os.path.basename(model_path)
    h_input, w_input, model_type, scale = parse_model_name(model_name)
    
    param = {
        "org_img": image,
        "bbox": image_bbox,
        "scale": scale,
        "out_w": w_input,
        "out_h": h_input,
        "crop": True,
    }
    if scale is None:
        param["crop"] = False
    
    img = image_cropper.crop(**param)
    start = time.time()
    
    prediction = model_test.predict(img, model_path)
    
    test_speed = time.time() - start

    label = np.argmax(prediction)
    value = prediction[0][label] 
    
    if label == 1:
        print(f"RESULT: REAL FACE | Score: {value:.2f}")
    else:
        print(f"RESULT: FAKE FACE | Score: {value:.2f}")
                
    return label
