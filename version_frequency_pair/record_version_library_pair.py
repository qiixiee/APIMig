# 统计lucene 迁移对
import pandas as pd
import os
import csv
from collections import defaultdict

# 定义Lucene的groupId前缀
LUCENE_GROUP_ID = "org.apache.lucene"

# 遍历所有CSV文件
csv_directory = "./dependency_changes"


def isVersion(version_id):
    if "{" not in version_id and "}" not in version_id and version_id != "unknown" and version_id != "RELEASE":
        return True

pair = []
for root, dirs, files in os.walk(csv_directory):
    for file in files:
        if file.endswith(".csv"):
            path = os.path.join(root, file)
            df = pd.read_csv(path)
            lucene_df = df[df["library"].str.startswith(LUCENE_GROUP_ID)]
            valid_rows = lucene_df.to_dict(orient='records')
            if(len(valid_rows) > 0):
                for i in range(len(valid_rows)):
                    change_type = valid_rows[i]["type"]
                    if change_type == "update":
                        old_version = valid_rows[i]["old_version"]
                        new_version = valid_rows[i]["new_version"]
                        if old_version != None and new_version != None and old_version != "nan" and new_version != "nan":
                            # 忽略-SNAPSHOT部分，只保留主版本号
                            new_version = new_version.split("-")[0]
                            old_version = old_version.split("-")[0]
                            if isVersion(old_version) and isVersion(new_version):                    
                                pair.append((old_version, new_version)) 

pair_frequency = {}
for item in pair:
    if item in pair_frequency:
        pair_frequency[item] += 1
    else:
        pair_frequency[item] = 1

sorted_pair = dict(sorted(pair_frequency.items(),key = lambda x: x[1], reverse=True))
print(sorted_pair)

for version_pair, count in sorted_pair.items():
    old_version = version_pair[0]
    new_version = version_pair[1]
    old_tuple = tuple(map(int, old_version.split(".")))
    new_tuple = tuple(map(int, new_version.split(".")))
    if old_tuple[0] - new_tuple[0] >= 1:
        print(f"{old_version} -> {new_version} count: {count}")
    if new_tuple[0] - old_tuple[0] >= 1:
        print(f"{old_version} -> {new_version} count: {count}")

# # 输出到 CSV 文件
# csv_file = "version_frequency_pair/pair_counts.csv"
# with open(csv_file, mode="w", newline="", encoding="utf-8") as file:
#     writer = csv.writer(file)
#     writer.writerow(["version_pair", "count"])  # 写入表头
#     for version_pair, count in sorted_pair.items():
#         writer.writerow([version_pair, count])  # 写入每行数据
# print(f"统计结果已保存到文件：{csv_file}")