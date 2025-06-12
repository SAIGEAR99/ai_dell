import os
import json
import re
from pathlib import Path
import google.generativeai as genai
import pdfplumber
from dotenv import load_dotenv

def get_json_schema_prompt():
    """
    สร้าง String ของโครงสร้าง JSON ทั้งหมดตามที่ผู้ใช้กำหนดเป็นเวอร์ชันสุดท้าย
    """
    schema = {
        "Product_Data": {
            "model_name": "string", "model_number": "string",
            "regulatory_info": { "model": "string", "type": "string" },
            "specifications": {
              "dimensions_and_weight": { "hight": "string", "width": "string", "deep": "string", "weight": { "minimum": "string" } },
              "processor": [ { "series": "string", "type": "string", "wattage": "string", "core_count": "integer", "thread_count": "integer", "speed": "string", "cache": "string", "integrated_graphics": "string" } ],
              "chipset": { "type": "string", "pcie_bus": "string" },
              "operating_systems": ["list of strings"],
              "memory": {
                "memory_configurations": [
                  {
                    "type": "string (e.g., LPDDR5x or DDR5)",
                    "speed": "string (e.g., 7467 MT/s)",
                    "capacity_options": ["list of strings (e.g., 8 GB, 16 GB, 32 GB)"]
                  }
                ],
                "maximum_memory": "string",
                "memory_slots": "string"
              },
              "gpu": { "integrated": [], "discrete": [] },
              "ports_and_slots": { "external_left": [], "external_right": [], "internal": [], "port_2.0_3.0_typeC": "See external_left and external_right for details" },
              "display": { "inch": "string", "resolution": ["list of strings"], "hz": ["list of strings"], "touch": "string", "non_touch": "string", "2_in_1_pen_support": "string", "monitor_details": {} },
              "storage": { "storage_configuration_boot_driver": "string", "supported_drive_types": [], "1st_storage": "Details in supported_drive_types", "2nd_storage": "Details in supported_drive_types", "3rd_storage": "Not found in manual", "hdd": "Not supported in this model", "raid_connectivity": "string", "optical_drive": "string", "media_card_reader": "string" },
              "camera": {}, "audio": { "speaker": "Details here" },
              "networking": { "network_card": { "wlan": {}, "wwan": {} }, "network_port_rj45": "string", "wireless": "See network_card details" }
            },
            "components_and_extras": { "keyboard": {}, "mouse": "string", "sim": "string", "finger_print_reader": {}, "fan": "string", "thermal_cooling": "string", "power_cord": "string", "cables_and_dongle": "string", "cable_cover": "string", "dust_protection": "string", "chassis_option": "string", "label": "string", "documentation": "string" },
            "power_and_battery": { "psu_power": [], "charger_port": "string", "charger_cable": "string", "battery": {}, "power_cord": "string" },
            "compliance_and_software": { "energy_star": "string", "epeat_2018": "string", "epeat_gold_silver": "string", "driver": "string", "bios": "string", "microsoft_office": "string", "intel_responsive_technology": "string" },
            "services": { "standard_hardware_support_service": "string", "extended_service": "string", "custom_delivery": "string" },
            "technical_details": { "information_about_cpu_when_use_V_U_H_its_has_or_not_has_RJ45": "string", "chipset": {}, "screw_list": [] }
        }
    }
    return json.dumps(schema, indent=2)


def generate_extraction_prompt(json_schema, full_pdf_text):
    """ประกอบ Prompt ทั้งหมดเพื่อส่งให้ Gemini"""
    return f"""
    You are an expert AI assistant specialized in meticulously extracting technical specifications from product manuals into a structured JSON format. Your task is to analyze the following text, which was extracted from a PDF document, and populate the JSON object according to the schema provided.

    **JSON Schema to Follow:**
    ```json
    {json_schema}
    ```

    **Instructions:**
    1.  Adhere strictly to the provided JSON schema and key names.
    2.  If a value for any key cannot be found in the provided text, you MUST use the string "Not found in manual". Do not leave any value blank, null, or empty.
    3.  Do not invent, guess, or infer information that is not explicitly stated in the text.
    4.  If a specification has multiple options (like different CPU models or PSU wattages), include all of them in the corresponding list.
    5.  Your final output must be ONLY the populated JSON object, enclosed in ```json ... ```, and nothing else. Do not include any introductory text or explanations in your response.

    **Here is the text extracted from the document:**
    ---
    {full_pdf_text}
    ---
    """

def extract_text_from_pdf(pdf_path):
    """ดึงข้อความทั้งหมดจาก PDF และใส่ตัวคั่นหน้า"""
    print("Extracting text from PDF...")
    full_text = ""
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
      
            text = page.extract_text(x_tolerance=1, y_tolerance=1)
            if text:
                full_text += f"\n\n--- PAGE {i+1} ---\n{text}"
    print("Text extraction complete.")
    return full_text

def clean_and_parse_json(api_response_text):
    """ฟังก์ชันสำหรับทำความสะอาดและแปลงข้อความตอบกลับจาก API ให้เป็น JSON"""
    print("Cleaning and parsing API response...")
    try:
        match = re.search(r'```json\s*(\{.*?\})\s*```', api_response_text, re.DOTALL)
        if match:
            json_string = match.group(1)
            return json.loads(json_string)
        
        first_brace_index = api_response_text.find('{')
        if first_brace_index == -1:
            raise ValueError("No starting brace '{' found in the response.")

        brace_count = 0
        for i, char in enumerate(api_response_text[first_brace_index:]):
            if char == '{':
                brace_count += 1
            elif char == '}':
                brace_count -= 1
            
            if brace_count == 0:
                end_index = first_brace_index + i + 1
                json_string = api_response_text[first_brace_index:end_index]
                return json.loads(json_string)
        
        raise ValueError("Could not find a matching closing brace '}' for the first object.")

    except (json.JSONDecodeError, ValueError) as e:
        print(f"--- ERROR PARSING JSON ---")
        print(f"Error: {e}")
        print("--- FULL API RESPONSE FOR DEBUGGING ---")
        print(api_response_text)
        print("---------------------------------------")
        return None

if __name__ == "__main__":
    try:
        print("Loading environment variables from .env file...")
        load_dotenv()
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("API Key not found in .env file. Please check your .env file.")
        
        genai.configure(api_key=api_key)
        print("API Key configured successfully.")

        script_dir = Path(__file__).parent
        pdf_file_path = script_dir / "raw_pdf" / "dell-pro-16-pc16250-owners-manual-en-us.pdf"
        output_file_path = script_dir / "result" / "final_specs_from_schema_16.json"
        
        log_dir = script_dir / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        output_file_path.parent.mkdir(parents=True, exist_ok=True)
        
        pdf_text = extract_text_from_pdf(pdf_file_path)

        with open(log_dir / "full_extracted_text.txt", "w", encoding="utf-8") as log_f:
            log_f.write(pdf_text)
        print(f"Full extracted text saved to logs/full_extracted_text.txt")

        json_schema = get_json_schema_prompt()
        prompt = generate_extraction_prompt(json_schema, pdf_text)
        
        print("Sending request to Gemini API... This may take a moment (can be 30-90 seconds).")
        
        generation_config = genai.types.GenerationConfig(
            response_mime_type="application/json"
        )
        model = genai.GenerativeModel("gemini-1.5-flash", generation_config=generation_config)
        
        response = model.generate_content(prompt, request_options={'timeout': 600})
        
        json_data = clean_and_parse_json(response.text)

        if json_data:
            with open(output_file_path, "w", encoding="utf-8") as f:
                json.dump(json_data, f, indent=4, ensure_ascii=False)
            
            print(f"\nSuccess! Data extracted and saved to: '{output_file_path}'")
        else:
            print("\nFailed to get a valid JSON object from the API response.")

    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")