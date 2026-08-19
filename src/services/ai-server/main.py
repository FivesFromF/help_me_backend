import os
import signal
import sys
import threading
import logging
from regconition_original import FaceProcessor
from worker import run_sqs_worker

logger = logging.getLogger("ai-main")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s")

def main():
    logger.info("Initializing FaceProcessor models...")
    processor = FaceProcessor()
    stop_event = threading.Event()

    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, shutting down gracefully...")
        stop_event.set()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("Starting SQS Worker...")
    run_sqs_worker(processor, stop_event)

if __name__ == "__main__":
    main()
