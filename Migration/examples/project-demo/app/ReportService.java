package demo.app;

import demo.shared.BaseService;
import demo.shared.Collaborator;

public class ReportService extends BaseService {
  private final Collaborator collaborator = new Collaborator();

  public void run() {
    collaborator.assist();
    String name = "done";
    String result = format(name);
    collaborator.assist();
    System.out.println(result);
  }
}
