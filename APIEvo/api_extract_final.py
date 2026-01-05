from selenium import webdriver
from selenium.webdriver.chrome.service import Service
import time
import openpyxl
from selenium.webdriver.common.by import By
import json
import re
import os


def get_method_detail(section, type, full_name, method_or_constructor, constructor_num, method_num, save_path):
    method_path= save_path + "Constructor.jsonl"
    constructor_path= save_path + "Method.jsonl"
    
    print(full_name)
    # 使用 XPath 获取第一层级的 ul 元素
    first_level_ul = section.find_element(By.XPATH, "./ul")  # 直接子元素
    # 获取所有嵌套的 ul 元素
    all_ul_elements = first_level_ul.find_elements(By.XPATH, (".//ul[contains(@class, 'blockList')]"));
    
    print(len(all_ul_elements), full_name, "有这么多ul元素,即有这么多方法")
    if method_or_constructor == "constructor":
        constructor_num = constructor_num + len(all_ul_elements)
    if method_or_constructor == "method":
        method_num = method_num + len(all_ul_elements)
    print(constructor_num,method_num,"当前总共")

    for ul in all_ul_elements:
        # prerare fields
        method_name = None
        method_modifier = None
        method_return_type = None
        method_parameters = [] # method_parameter_name	method_parameter_type	method_parameter_description
        method_parameters_description = None
        method_throws = None
        method_description = ""
        method_belong_type = type
        method_belong_name = full_name

        # 整个ul的所有内容，按行读取，用于获得名字   
        ul_lines = ul.text.splitlines()
        method_name = ul_lines[0]
        
        # Signarture content 
        signarture_content = ul.find_element(By.TAG_NAME, "pre").text
        print("signarture_content", signarture_content)

        if "throws" in signarture_content:
            method_throws = signarture_content.split("throws")[1].strip()
        # 丢掉throw部分
        signarture_content = signarture_content.split("throws")[0].strip()
            
        # 提取出signarture_content中的method_modifier，method_return_type，method_parameters
        signarture_content_split = signarture_content.split(method_name+"(")
        modifier_with_type = signarture_content_split[0]
        parameters_with_throws = signarture_content_split[1].split(")")[0]

        print("print modifier_with_type", modifier_with_type)
        print("print parameters_with_throws", parameters_with_throws)


        # 处理修饰符和返回值
        if method_or_constructor == "constructor": # 构造函数没有返回值
            method_modifier = modifier_with_type.strip() # protected AbstractAnalysisFactory​(Map<String,​String> args)
        elif method_or_constructor == "method":  # 普通方法有返回值
            modifier_with_type_list = modifier_with_type.strip().split(" ")
            method_return_type = modifier_with_type_list[-1]
            method_modifier = " ".join(modifier_with_type_list[:-1])

        parameters_with_throws = parameters_with_throws.replace('\n', '')

        arguments = [ v.strip() for v in parameters_with_throws.split(", ")]
        print("arguments如下", arguments)
        if len(arguments) != 0:
            for param in arguments: # 对于每一个参数对，应该是空格分割的最后一个为参数名
                if param:
                    parts = param.split()
                    # 获取数据类型（前面的部分）
                    param_type = " ".join(parts[:-1])  # 处理可能存在多个空格的情况
                    # 获取参数名（最后一个部分）
                    param_name = parts[-1]
                    method_parameters.append({
                        'method_parameter_name': param_name,
                        'method_parameter_type': param_type,
                    })

        # 参数描述信息
        if len(ul.find_elements(By.CLASS_NAME, "paramLabel")) != 0:
            method_parameters_description = ul.find_element(By.CLASS_NAME, "paramLabel").text
        
        # 剩余描述信息部分
        all_texts = " ".join([ line for line in ul_lines])
        # 找到第一个右括号的索引
        right_paren_index = all_texts.find(')')

        # 检查是否找到
        if right_paren_index != -1:
            # 截取右括号后面的文本
            substring_after_right_paren = (all_texts[right_paren_index + 1:]).strip()  # +1 是为了跳过右括号本身
            print(f"第一个右括号后面的文本是: {substring_after_right_paren}")
        else:
            print("文本中没有找到右括号。")
        
        method_description = substring_after_right_paren
        #异常处理
        
        if method_or_constructor == "constructor":
            constructor_data = {
                "method_name": method_name,
                "method_modifier": method_modifier,
                "method_parameters": method_parameters,
                "method_description": method_description,
                "method_belong_type": method_belong_type,
                "method_belong_name": method_belong_name
            }
            with open(constructor_path, "a") as f:
                f.write(json.dumps(constructor_data, ensure_ascii=False) + "\n")
        if method_or_constructor == "method":
            method_data = {
                "method_name": method_name,
                "method_modifier": method_modifier,
                "method_return_type": method_return_type,
                "method_parameters": method_parameters,
                "method_parameters_description": method_parameters_description,
                "method_throws": method_throws,
                "method_description": method_description,
                "method_belong_type": method_belong_type,
                "method_belong_name": method_belong_name
            }
            with open(method_path, "a") as f:
                f.write(json.dumps(method_data, ensure_ascii=False) + "\n")
    return constructor_num, method_num


                        


def get_field_detail(section, type, full_name, save_path): # type 可能为 class（Field Detail） or interface（Field Detail） or enum（Enum Constant Detail ，Field Detail）
    enum_constant_path = save_path + "Enum_Constant.jsonl"
    field_path = save_path + "Field.jsonl"
    # 使用 XPath 获取第一层级的 ul 元素
    first_level_ul = section.find_element(By.XPATH, "./ul")  # 直接子元素
    # 获取所有嵌套的 ul 元素
    all_ul_elements = first_level_ul.find_elements(By.TAG_NAME, "ul")
    for ul in all_ul_elements:
        # prerare fields
        field_name = None
        field_modifier = None
        field_datatype = None
        field_value = None
        field_description = ""
        field_belong_type = type
        field_belong_name = full_name
        print(ul.text)
        ul_lines = ul.text.splitlines()
        if ul_lines:
            field_name = ul_lines[0]
            
        for index, line in enumerate(ul_lines):
            if line:  # 判断行是否为空
                if index == 0:
                    field_name = ul_lines[0]
                elif field_name in line and ("public" in line or "private" in line or "protected" in line):
                    modifier_type_content = line.split(field_name)[0] # protected final Version
                    modifier_type = modifier_type_content.strip().split(" ")
                    field_datatype = modifier_type[len(modifier_type)-1]
                    field_modifier = " ".join(modifier_type[:-1])
                else:
                    field_description += line + "\n"

        if type == "enum":
            enum_constant_data = {
                "enum_constant_name": field_name,
                "enum_constant_datatype": field_datatype,
                "enum_constant_modifier": field_modifier,
                "enum_constant_value": field_value,
                "enum_constant_description": field_description,
                "enum_constant_belong_type": field_belong_type,
                "enum_constant_belong_name": field_belong_name
            }
            print("print enum_constant_data", enum_constant_data)
            with open(enum_constant_path, "a") as f:
                f.write(json.dumps(enum_constant_data, ensure_ascii=False) + "\n")
        else:
            field_data = {
                "field_name": field_name,
                "field_datatype": field_datatype,
                "field_modifier": field_modifier,
                "field_value": field_value,
                "field_description": field_description,
                "field_belong_type": field_belong_type,
                "field_belong_name": field_belong_name
            }
            print("print field_data", field_data)
            with open(field_path, "a") as f:
                f.write(json.dumps(field_data, ensure_ascii=False) + "\n")



def get_Detail(wd, name, constructor_num, method_num, save_path):
# get the package name and full class name
    package_name = wd.find_element(By.CLASS_NAME, "subTitle").text.split(" ")[1]
    full_name = package_name + "." + name
    # get the data type，class/interface/enum
    title = wd.find_element(By.CLASS_NAME, "title").text
    type = title.split(" ")[0].lower()

    # 按定位找到字段
    # 定位到 .details 元素
    # 检查是否存在指定类名的元素
    details_elements = wd.find_elements(By.CLASS_NAME, "details")

    if details_elements:
        # 如果存在，打印找到的元素数量
        details_element = details_elements[0]  # 获取第一个元素进行后续操作
    else:
        print("No details element found.")
        return constructor_num, method_num
    
    # 定位到所有 section 元素
    sections = details_element.find_elements(By.TAG_NAME, "section")
    # 遍历每个 section
    for section in sections:
        h3_element = section.find_element(By.TAG_NAME, "h3")
        section_type = h3_element.text.strip()  # 获取 h3 的文本内容并去除空白
        print("当前", section_type)

        if section_type == "Field Detail" or section_type == "Enum Constant Detail":
            get_field_detail(section, type, full_name,save_path)
        if section_type == "Constructor Detail":
            constructor_num, method_num = get_method_detail(section, type, full_name, "constructor",constructor_num, method_num,save_path)
        if section_type == "Method Detail":
            constructor_num, method_num = get_method_detail(section, type, full_name, "method",constructor_num, method_num,save_path)
        
    return constructor_num, method_num

# 进入页面时，部分版本的页面通过frame创建，部分没有，因此有下面两种区别
def top_crawler_9(wd, data, class_path, interface_path, enum_path):
    class_name = data.text
    # Jump to the detail page 
    data.find_element(By.TAG_NAME, "a").click()
    # get the package name and full class name
    package_name = wd.find_element(By.CLASS_NAME, "subTitle").text
    full_class_name = package_name + "." + class_name
    # get the data type，class/interface/enum
    title = wd.find_element(By.CLASS_NAME, "title").text
    type = title.split(" ")[0].lower()
    # get the all description，deal with text in lines
    class_description_element = wd.find_element(By.CLASS_NAME, "description")
    lines = class_description_element.text.splitlines()
    # prepare fields
    modifier = None
    extents = None
    implements = None
    description = ""
    for line in lines:
        if "public" in line or "private" in line or "protected" in line:
            modifier = line.split(type)[0]
        elif "extends" in line:
            extents = line.split("extends")[1].strip()
        elif "implements" in line:
            implements = line.split("implements")[1].strip()
        else:
            if modifier:
                description += line + "\n"

    dump_data = {
        "type": type,
        "package_name": package_name,
        "full_name": full_class_name,
        "modifier": modifier,
        "extents": extents,
        "implements": implements,
        "description": description
    }

    # 写入jsonl文件
    if type == "class":
        with open(class_path, "a") as f:
            f.write(json.dumps(dump_data, ensure_ascii=False) + "\n")
    elif type == "interface":
        with open(interface_path, "a") as f:
            f.write(json.dumps(dump_data, ensure_ascii=False) + "\n")
    elif type == "enum":
        with open(enum_path, "a") as f:
            f.write(json.dumps(dump_data, ensure_ascii=False) + "\n")

    wd.back()

def top_crawler_other(wd, data, save_path):
    wd.switch_to.parent_frame()
    print("切换到 main Frame")
    time.sleep(0.1)
    wd.switch_to.frame("packageFrame")
    print("切换到packageFrame")
    time.sleep(0.1)

    print(data)
    class_name = data.text
    print(class_name)
    # Jump to the detail page 
    data.find_element(By.TAG_NAME, "a").click()
    time.sleep(0.1)
    wd.switch_to.parent_frame()
    print("切换到 main Frame")
    time.sleep(0.1)
    wd.switch_to.frame("classFrame")
    print("切换到classFrame")
    # get the package name and full class name   拿到包名和完全限定名
    package_name = wd.find_element(By.CLASS_NAME, "subTitle").text
    full_class_name = package_name + "." + class_name
    print(full_class_name,package_name,"-----------")
    # get the data type，class/interface/enum   拿到类型
    title = wd.find_element(By.CLASS_NAME, "title").text
    type = title.split(" ")[0].lower()
    # get the all description，deal with text in lines  拿到description
    class_description_element = wd.find_element(By.CLASS_NAME, "description")
    lines = class_description_element.text.splitlines()
    # prepare fields 准备顶层域的数据
    modifier = None
    extents = None
    implements = None
    description = ""
    for line in lines:
        if "public" in line or "private" in line or "protected" in line:
            modifier = line.split(type)[0]
        elif "extends" in line:
            extents = line.split("extends")[1].strip()
        elif "implements" in line:
            implements = line.split("implements")[1].strip()
        else:
            if modifier:
                description += line + "\n"

    dump_data = {
        "type": type,
        "package_name": package_name,
        "full_name": full_class_name,
        "modifier": modifier,
        "extents": extents,
        "implements": implements,
        "description": description
    }
    class_path = save_path + "Class.jsonl"
    interface_path = save_path + "Interface.jsonl"
    enum_path = save_path + "Enum.jsonl"
    # 写入jsonl文件
    if type == "class":
        with open(class_path, "a") as f:
            f.write(json.dumps(dump_data, ensure_ascii=False) + "\n")
    elif type == "interface":
        with open(interface_path, "a") as f:
            f.write(json.dumps(dump_data, ensure_ascii=False) + "\n")
    elif type == "enum":
        with open(enum_path, "a") as f:
            f.write(json.dumps(dump_data, ensure_ascii=False) + "\n")

    
    # 处理下面的detail部分
    detail_crawler(save_path)

def top_crawler(url, save_path):
    # Library Crawl,  Crawl class、interface and enum
    chrome_driver_path = '/usr/local/bin/chromedriver'
    service = Service(chrome_driver_path)
    wd = webdriver.Chrome(service=service)
    wd.get(url)

    # 带frame使用方式
    wd.switch_to.frame("packageFrame")
    table = wd.find_element(By.CLASS_NAME, "indexContainer").find_element(By.TAG_NAME, "ul")
    table_data = table.find_elements(By.TAG_NAME, "li")  # 白给
    # every item in AllClasses
    for data in table_data:
        top_crawler_other(wd, data, save_path)
    
    # 9版本使用方式
    # table = wd.find_element(By.CLASS_NAME, "indexContainer").find_element(By.TAG_NAME, "ul")
    # table_data = table.find_elements(By.TAG_NAME, "li")
    # # every item in AllClasses
    # for data in table_data:
    #     top_crawler_9(wd, data, class_path, interface_path, enum_path)
    return

def detail_crawler(url, save_path):
    # Library Crawl,  Crawl field、constructor、method
    chrome_driver_path = '/usr/local/bin/chromedriver'
    service = Service(chrome_driver_path)
    wd = webdriver.Chrome(service=service)
    wd.get(url)

    table = wd.find_element(By.CLASS_NAME, "indexContainer").find_element(By.TAG_NAME, "ul")
    table_data = table.find_elements(By.TAG_NAME, "li")  # 白给
    # every item in AllClasses
    constructor_num = 0 
    method_num = 0
    for index, data in enumerate(table_data):
        # maintain name
        name = data.text
        # Jump to the detail page 
        data.find_element(By.TAG_NAME, "a").click()
        constructor_num, method_num = get_Detail(wd, name,constructor_num, method_num, save_path)
        wd.back()
    return constructor_num, method_num

def constant_crawler(url, save_path):
    constant_path = save_path + "Constant_Field.jsonl"
    chrome_driver_path = '/usr/local/bin/chromedriver'
    service = Service(chrome_driver_path)
    wd = webdriver.Chrome(service=service)
    wd.get(url)
    tables = wd.find_elements(By.CLASS_NAME, "constantsSummary")
    for table in tables:
        caption = table.find_element(By.TAG_NAME, "caption")
        print("caption", caption.text) 
        # 拿类型
        caption.find_element(By.TAG_NAME, "a").click()
        # get the data type，class/interface/enum
        title = wd.find_element(By.CLASS_NAME, "title").text
        type = title.split(" ")[0].lower()
        wd.back()

        # 读表
        rows = table.find_elements(By.XPATH, ".//tbody/tr")
        for row in rows:
            if "Modifier and Type" not in row.text:
                # 提取 Modifier and Type, Constant Field 和 Value
                modifier_and_type = row.find_element(By.CLASS_NAME, "colFirst").text
                parts = modifier_and_type.split()

                # 修饰符是在返回值类型之前的部分
                constant_modifier = " ".join(parts[:-1])  # 提取所有部分，除了最后一个
                constant_type = parts[-1]  # 最后一个部分是返回值类型

                constant_name = row.find_element(By.CLASS_NAME, "colSecond").text

                value = row.find_element(By.CLASS_NAME, "colLast").text

                constant_data = {
                    "constant_name": constant_name,
                    "constant_type": constant_type,
                    "constant_modifier": constant_modifier,
                    "belong_type":type,
                    "belong_name":caption.text,
                    "constant_value": value
                }
                print(constant_data)
                with open(constant_path, "a") as f:
                    f.write(json.dumps(constant_data, ensure_ascii=False) + "\n")


def crawler(all_class_url, constant_url, save_path):
    top_crawler(all_class_url, save_path)
    constructor_num, method_num = detail_crawler(all_class_url,save_path)
    print(constructor_num, method_num)
    constant_crawler(constant_url,save_path)

if __name__ == '__main__':
    # 定义版本号
    version = "8_11_1"

    # 创建完整的目录路径
    # 假设您希望将目录创建在一个名为 "output" 的根目录下
    directory = os.path.join("output", version)

    # 检查目录是否存在，如果不存在则创建它
    if not os.path.exists(directory):
        os.makedirs(directory)


    # crawler("https://lucene.apache.org/core/9_7_0/core/allclasses.html", "https://lucene.apache.org/core/9_7_0/core/constant-values.html", "output/"+version+"/")
    crawler("https://lucene.apache.org/core/8_11_1/core/index.html", "https://lucene.apache.org/core/8_11_1/core/constant-values.html", "output/"+version+"/")

    
    # 网站爬取
    






