# 统计lucene库使用频率 按模块 版本号 频次分
import pandas as pd
import os
import csv
from collections import defaultdict

# 定义Lucene的groupId前缀
LUCENE_GROUP_ID = "org.apache.lucene"

# 遍历所有CSV文件
csv_directory = "./dependency_changes"

all_library_version = {}
for root, dirs, files in os.walk(csv_directory):
    for file in files:
        if file.endswith(".csv"):
            library_version_counts = {}
            valid_rows = []
            path = os.path.join(root, file)
            df = pd.read_csv(path)
            lucene_df = df[df["library"].str.startswith(LUCENE_GROUP_ID)]
            valid_rows = lucene_df.to_dict(orient='records')
            if(len(valid_rows) > 0):
                for i in range(len(valid_rows)):
                    library_name = valid_rows[i]["library"]
                    change_type = valid_rows[i]["type"]
                    old_version = valid_rows[i]["old_version"]
                    new_version = valid_rows[i]["new_version"]
                    # 字典中已经存在该库的记录，那么往里面加版本的记录
                    if(library_version_counts.get(library_name) != None):
                        version_counts = library_version_counts[library_name]
                        version_keys = list(version_counts.keys())

                        if change_type == "add":
                            # 新增指定库版本依赖 找到该依赖+1
                            if (new_version not in version_keys):
                                version_counts[new_version] = 1
                        
                        if change_type == "remove":
                            # 新增指定库版本依赖 找到该依赖+1
                            if (old_version not in version_keys):
                                version_counts[old_version] = 1

                        if change_type == "update":
                            if (new_version not in version_keys):
                                version_counts[new_version] = 1
                            if (old_version not in version_keys):
                                version_counts[old_version] = 1
                    else: # 字典里面不存在该库记录 第一次见 那么新增记录
                        library_version_counts[library_name] = {}
                        if change_type == "add":
                            library_version_counts[library_name] = {}
                            library_version_counts[library_name][new_version] = 1
                        
                        if change_type == "remove":
                            library_version_counts[library_name] = {}
                            library_version_counts[library_name][old_version] = 1

                        if change_type == "update":
                            library_version_counts[library_name] = {}  
                            library_version_counts[library_name][new_version] = 1                    
                            library_version_counts[library_name][old_version] = 1
            if (len(library_version_counts) > 0):
                all_library_version[path] = library_version_counts

# 初始化一个字典来存储最终的统计结果
library_version_summary = {}
def parse_version(version):
    """
    将版本号字符串解析为可比较的元组，忽略-SNAPSHOT部分。
    例如：'0.7-SNAPSHOT' -> (0, 7)
    """
    # 去掉-SNAPSHOT部分
    version = version.split("-")[0]
    return tuple(map(int, version.split(".")))

# 遍历数据并统计
for file, libraries in all_library_version.items():
    for library, versions in libraries.items():
        if library not in library_version_summary:
            library_version_summary[library] = {}
        for version, count in versions.items():
            # 忽略-SNAPSHOT部分，只保留主版本号
            version = version.split("-")[0]
            if "{" not in version and "}" not in version and version != "unknown" and version != "RELEASE":
                if version not in library_version_summary[library]:
                    library_version_summary[library][version] = 0
                library_version_summary[library][version] += count
                print(file, library, version, count)
                test = tuple(map(int, version.split(".")))

# 将结果转换为列表并排序
sorted_results = []
for library, versions in library_version_summary.items():
    print(library)
    # 按版本号排序（使用自定义的解析函数）
    for version, count in sorted(versions.items(), key=lambda x: parse_version(x[0])):
        sorted_results.append((library, version, count))

# 按库名排序
sorted_results.sort(key=lambda x: x[0])

# 输出到 CSV 文件
csv_file = "./dependency_counts.csv"
with open(csv_file, mode="w", newline="", encoding="utf-8") as file:
    writer = csv.writer(file)
    writer.writerow(["library", "version_id", "count"])  # 写入表头
    for library, version, count in sorted_results:
        writer.writerow([library, version, count])  # 写入每行数据

print(f"统计结果已保存到文件：{csv_file}")